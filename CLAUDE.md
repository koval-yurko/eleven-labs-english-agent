# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Web is deprecated. Mobile is the product.

**`apps/mobile` (Expo / React Native, iOS) is the only client under active development.** Every new
feature is researched, designed and built from the mobile perspective — screens, navigation, offline
behaviour, UX. If a task says "add feature X", it means add it to the mobile app.

**`apps/web` (Next.js) is deprecated as a UI and is kept as the backend.** It still owns the API
routes, Auth0 session handling, Supabase access, the ElevenLabs agent registry, the LLM jobs and the
migrations — the mobile app talks to it over HTTP. Do not build new screens there, and do not spend
effort on its remaining pages beyond keeping them compiling.

The reason the native app exists: iOS revokes the microphone and drops the socket the moment Safari
leaves the foreground, so a browser voice lesson cannot survive a locked screen. See
`docs/2026-08-12-expo-app-creation.md` and the stage plan in `docs/2026-08-12-expo-build-plan.md`.

## What this is

An English tutor: a learner collects vocabulary and practises it in a live voice lesson with an
ElevenLabs Conversational AI agent. Integrations: **Auth0** (login), **Supabase** (Postgres,
owner-scoped with RLS), **ElevenLabs** (the tutor agents), **LangChain + Anthropic** (server-side LLM
jobs, traced to LangSmith).

TypeScript (strict), Node 22 LTS, **pnpm workspace on pnpm 11+**.

## Layout

```text
apps/
  mobile/            # Expo SDK 57 app — the active client. src/app/ is the expo-router root.
  web/               # Next.js — backend only: src/app/api/, src/lib/, src/agent/, scripts/
packages/
  shared/            # @tutor/shared — pure core, zero runtime deps, shared by both apps
supabase/migrations/ # Postgres schema, applied via pnpm db:migrate
docs/                # research notes, date-stamped Markdown
spec/PRD-base.md     # original product vision (reference)
```

`supabase/`, `docs/` and `spec/` stay at the repo root on purpose — they span both apps.

## Commands

Run everything from the repo root; each script delegates with `pnpm --filter`.

```bash
pnpm mobile            # Expo dev server (apps/mobile also has: pnpm check, ios, bundle)
pnpm dev               # the web backend (http://localhost:3000)
pnpm typecheck         # strict TS across every package
pnpm lint              # ESLint across every package
pnpm check:shared      # property checks for packages/shared
pnpm db:migrate        # apply Supabase migrations (needs SUPABASE_DB_URL); :status to inspect
pnpm sync:agents       # reconcile ElevenLabs agents with apps/web/src/agent/prompts/
pnpm level:items       # assign CEFR levels to unlevelled words
pnpm enrich:words      # fill words.details (RU translations, forms, examples)
pnpm lexicon:load      # load the lexicon; pnpm level:lexicon levels it
```

Every job has a `:plan` variant that dry-runs and makes zero LLM calls. Before pushing mobile work,
run `pnpm --filter mobile check` (typecheck → lint → expo-doctor → bundle).

**pnpm 11+ is required; pnpm 9 fails silently** — it ignores the `nodeLinker: hoisted` /
`hoistingLimits` keys in `pnpm-workspace.yaml` and produces a symlinked layout that breaks React
Native tooling. Verify with `pnpm config get node-linker` → must print `hoisted`.

## Conventions

- **Secrets stay server-side.** `ANTHROPIC_API_KEY`, `xi-api-key` and the Supabase service-role key
  never leave the web backend. The mobile app gets data through authenticated API routes.
- **Ownership is enforced in code.** Every Supabase query filters/stamps `owner_id` (the Auth0
  `sub`); RLS is defense-in-depth (`supabase/README.md`).
- **`packages/shared` is the pure core; dependencies point inward only.** It holds what both clients
  must agree on: DTOs, the items-page query grammar, the HTTP contract (`api.ts`), the tutor wire
  contract, the offline op algebra, the mirror-store interface. Nothing in `src/` may import from an
  app or from any npm package — `no-restricted-imports` and a `types: []` tsconfig make that a
  compile error, and `dependencies` must stay empty. Import by name: `@tutor/shared/word-types`.
  The test for adding something here: _if this had a bug, could I fix it by deploying the web app
  alone?_ If yes, it belongs on the server. Mobile must never copy from this package.
  See `docs/2026-08-09-shareable-core-refactor.md`.
- **The data model: `words` is the vocabulary; lessons reference it many-to-many** via `lesson_items`
  (`lesson_id` + `word_id` + `position`). A word belongs to the learner, not a lesson, so a word in
  no lesson is a normal state. Word identity (`norm_key`) needs Postgres (unaccent + NFKC), so text →
  word id always goes through the `resolve_words` RPC, never a client-side guess. Client-side
  normalization lives in `packages/shared/src/word-key.ts` and is deliberately *weaker* than the
  Postgres identity — merging less only leaves a duplicate for the server to skip, merging more would
  silently drop a word the learner typed.
- **`words.level` and `words.details` are written only by background jobs**, never by the UI.
  Both run two ways: `after()` on the write path (fast) and a sweep script (backfill). The `*_at`
  columns are ATTEMPTED flags, stamped whether or not the model answered, so an un-answerable word is
  asked about once rather than every sweep. Both columns are nullable forever, so the jobs have no
  deadline and the app needs no scheduler. See `docs/2026-07-16-level-assignment-background-job.md`
  and `docs/2026-07-18-word-details-enrichment-job.md`.
- **Tutor prompts are a versioned source registry** (`apps/web/src/agent/prompts/` — one module per
  version). The filesystem is the source of truth; `pnpm sync:agents` reconciles ElevenLabs to match
  and records each version's agent id in the committed `agents.lock.json`, which clients read via
  `lib/agent-registry.ts`. After adding, editing or deleting a version, run the sync and commit the
  lockfile. See `docs/2026-06-27-agent-prompt-version-switching.md`.
- **LLM access goes through LangChain.** `apps/web/src/lib/llm.ts` builds a `ChatAnthropic`
  defaulting to `claude-opus-4-5` (override with `ANTHROPIC_MODEL`); with `LANGSMITH_API_KEY` set,
  calls auto-trace to LangSmith.
- **Transcript writes are sanitized by one function.** The action, the beacon route and the
  post-call webhook all upsert the same `conversation_id` row and all pass through
  `sanitizeTranscript` (`packages/shared/src/tutor.ts`), so the stored row doesn't depend on which
  writer landed last.
- **Offline writes are mirror + outbox in one transaction.** A mirror write and its queued op go in
  the same `transact`, which is why the UI can never show a change whose intent wasn't queued. Op
  rules live in `packages/shared/src/sync-ops.ts` and the storage contract in `mirror-store.ts`;
  today the only full implementation is Dexie (`apps/web/src/lib/sync/`) — mobile shares the types
  and keeps its own `expo-sqlite` session journal. Reactivity stays per-platform on purpose.
- **Research documents live in `docs/` as date-stamped Markdown** (e.g. `docs/2026-06-26-topic.md`)
  so the research history stays traceable.
