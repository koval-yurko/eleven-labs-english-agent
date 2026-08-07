# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A minimal **Next.js (App Router)** scaffold — a clean starting point that proves four
integrations are wired and working:

- **Auth0** — login / session gating.
- **Supabase** — Postgres with owner-scoped rows + RLS.
- **ElevenLabs** — provisioning the live-story Conversational AI agent (prompt + script).
- **LangChain + Anthropic (Claude)** — server-side LLM calls, auto-traceable to LangSmith.

The home page (`src/app/page.tsx`) is an integration smoke test that surfaces the health of
each and lets you exercise a Supabase write and a live Claude call.

TypeScript (strict), Node 22 LTS, single pnpm package (no workspace).

## Layout

```text
src/
  app/          # Next.js App Router: layout, smoke-test dashboard, server actions, /api/health
  lib/          # auth0 + session, supabase (service & user clients), config, health, llm
  agent/        # ElevenLabs tutor agents: prompts/ version registry, sync-agents.ts, agents.lock.json
supabase/
  migrations/   # Postgres schema (owner-scoped RLS) — applied via pnpm db:migrate
scripts/        # migrate.mjs (db migration runner)
spec/PRD-base.md  # the original product vision (reference)
docs/           # research notes (Markdown, date-stamped — see Conventions)
```

## Commands

```bash
pnpm dev               # run the app (http://localhost:3000)
pnpm build             # production build
pnpm typecheck         # strict TS (tsc --noEmit)
pnpm lint              # ESLint flat config
pnpm db:migrate        # apply Supabase migrations (needs SUPABASE_DB_URL)
pnpm sync:agents       # reconcile ElevenLabs agents with src/agent/prompts/ (writes agents.lock.json)
pnpm sync:agents:plan  # dry-run: print the reconcile plan, change nothing
pnpm level:items       # assign CEFR levels (A2–C2) to vocabulary items that have none yet
pnpm level:items:plan  # dry-run: print what would be levelled, make zero LLM calls
pnpm enrich:words      # fill words.details (RU translations, forms, examples) for un-enriched words
pnpm enrich:words:plan # dry-run: print what would be enriched, make zero LLM calls
```

## Conventions

- **Secrets stay server-side.** `ANTHROPIC_API_KEY`, `xi-api-key`, and the Supabase
  service-role key never reach the browser. Only `NEXT_PUBLIC_*` values are client-visible.
- **Ownership is enforced in code.** Every Supabase query filters/stamps `owner_id` (the
  Auth0 `sub`); RLS is defense-in-depth (see `supabase/README.md`).
- **LLM access goes through LangChain.** `src/lib/llm.ts` builds a `ChatAnthropic`
  (`@langchain/anthropic`) defaulting to `claude-opus-4-8` (override with `ANTHROPIC_MODEL`).
  With `LANGSMITH_API_KEY` set, calls auto-trace to LangSmith.
- **Tutor prompts are a versioned source registry** (`src/agent/prompts/` — one self-describing
  module per version). The filesystem is the source of truth; `pnpm sync:agents` reconciles
  ElevenLabs to match (create / update-in-place / retire) and records each version's agent id in
  the committed `src/agent/agents.lock.json`. The runtime/UI read the lockfile via
  `src/lib/agent-registry.ts`; a lesson page (`/lessons/[id]`) lets you pick a version per
  session. After adding,
  editing, or deleting a prompt version, run `pnpm sync:agents` and commit the lockfile. See
  `docs/2026-06-27-agent-prompt-version-switching.md`.
- **The vocabulary is `words`; lessons reference it many-to-many.** A word is owned by the learner,
  not by a lesson: `words` holds the text, its `norm_key` identity, and its attributes, and
  `lesson_items` is the join table (`lesson_id` + `word_id` + `position`). A word in no lesson is a
  normal state — either added directly on `/lesson-items` or removed from every lesson it was in.
  `norm_key` needs Postgres (unaccent + NFKC), so text → word id always goes through the
  `resolve_words` RPC in `src/lib/words.ts`, never a client-side guess. See
  `docs/2026-07-16-add-word-on-lesson-items-page.md`.
- **CEFR levels are written only by the level job**, never by the UI. `words.level`
  is filled in by `src/lib/levels.ts`, triggered two ways: `after()` on the word-write paths (fast)
  and `pnpm level:items` (the sweep that backfills and catches what the fast path dropped).
  `level_at` is the processed flag — it is stamped when the job **attempted** an item, not when it
  succeeded, so an item the model had no answer for is asked about once rather than on every
  sweep. `level` is nullable forever ("unleveled" is a real state), so the job has no deadline and
  the app needs no scheduler. See `docs/2026-07-16-level-assignment-background-job.md` (written
  against the pre-0007 `lesson_item_attrs` table; the design is unchanged, the columns moved).
- **Word details (`words.details`) are written only by the enrichment job**, never by the UI — the
  level job's machinery a second time. `src/lib/word-details.ts` asks the LLM for a per-word payload
  (RU translations, part of speech, word-family forms with their translations, example sentences),
  triggered two ways: `after()` on the word-write paths (fast) and `pnpm enrich:words` (the sweep).
  `details_at` is the ATTEMPTED flag (stamped whether or not a payload came back, so an un-enrichable
  item is asked about once, not every sweep); `details` is nullable forever. Batches are small (4)
  because each answer is a large object — a big batch truncates and loses data. The word detail page
  (`/lesson-items/[id]`) renders it; `getItem` reads `details` with its own narrow query so the list
  view stays lean. See `docs/2026-07-18-word-details-enrichment-job.md`.
- **A voice session is foreground-only, and the UI must say so.** iOS revokes the microphone,
  interrupts Web Audio and drops the socket the moment Safari leaves the foreground, so a browser
  session cannot run in the background at all (`docs/2026-08-07-ios-locked-screen-background-voice.md`;
  `docs/2026-08-07-Expo-migration.md` is the native way out). What the app owes the learner instead
  is that the session never dies quietly while the tab is open: `useKeepAwake` holds the screen
  (we pass `useWakeLock: false` — the SDK swallows its own wake-lock failures), `useAudioHealth`
  catches an interrupted audio graph that would otherwise look connected, hiding the page for more
  than 2s ends the session on purpose, and every transcript line is journalled to the mirror DB and
  beaconed to `/api/lessons/session` before iOS can discard the tab. Transcript writes go through
  `src/lib/tutor-session.ts` — the action, the beacon route and the post-call webhook all upsert the
  same conversation_id row. See `docs/2026-08-07-ios-keep-session-alive-foreground.md`.
- **Research documents live in `docs/` as Markdown.** Keep every research note in the `docs/`
  folder in Markdown format, and include the date in the file name (e.g.
  `docs/2026-06-26-topic.md`) so the research history stays traceable.
