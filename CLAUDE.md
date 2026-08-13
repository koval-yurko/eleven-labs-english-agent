# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A minimal **Next.js (App Router)** scaffold — a clean starting point that proves four
integrations are wired and working:

- **Auth0** — login / session gating.
- **Supabase** — Postgres with owner-scoped rows + RLS.
- **ElevenLabs** — provisioning the live-story Conversational AI agent (prompt + script).
- **LangChain + Anthropic (Claude)** — server-side LLM calls, auto-traceable to LangSmith.

The home page (`apps/web/src/app/page.tsx`) is an integration smoke test that surfaces the health of
each and lets you exercise a Supabase write and a live Claude call.

TypeScript (strict), Node 22 LTS, **pnpm workspace** (`apps/*` + `packages/*`) on **pnpm 11+**.

## Layout

```text
apps/
  web/                # the Next.js app — everything below is relative to apps/web/
    src/
      app/            # App Router: layout, dashboard, server actions, /api/*
      lib/            # auth0 + session, supabase (service & user clients), config, health, llm, sync/
      agent/          # ElevenLabs tutor agents: prompts/ registry, sync-agents.ts, agents.lock.json
      proxy.ts        # the Auth0 cookie gate
    scripts/          # migrate.mjs, level-items.ts, enrich-words.ts
packages/
  shared/             # @tutor/shared — the pure core, zero runtime deps (see Conventions)
    src/              # shapes + rules; nothing here may import outward
    check.ts          # its property suite — sits BESIDE src/ so the core stays node-free
supabase/
  migrations/         # Postgres schema (owner-scoped RLS) — applied via pnpm db:migrate
spec/PRD-base.md      # the original product vision (reference)
docs/                 # research notes (Markdown, date-stamped — see Conventions)
```

`supabase/`, `docs/` and `spec/` stay at the **repo root** on purpose: the database is shared
infrastructure and the notes span both apps, so neither belongs to `apps/web`. See
`docs/2026-08-09-expo-repo-structure-migration.md` for the layout and the reasoning.

## Commands

**Run everything from the repo root.** Each root script delegates with `pnpm --filter`, so no `cd`
is needed and every name below is unchanged from before the workspace conversion.

```bash
pnpm dev               # run the app (http://localhost:3000)
pnpm build             # production build
pnpm typecheck         # strict TS (tsc --noEmit) across every package
pnpm lint              # ESLint flat config across every package
pnpm db:migrate        # apply Supabase migrations (needs SUPABASE_DB_URL)
pnpm db:migrate:status # list applied/pending migrations, change nothing
pnpm sync:agents       # reconcile ElevenLabs agents with apps/web/src/agent/prompts/
pnpm sync:agents:plan  # dry-run: print the reconcile plan, change nothing
pnpm level:items       # assign CEFR levels (A2–C2) to vocabulary items that have none yet
pnpm level:items:plan  # dry-run: print what would be levelled, make zero LLM calls
pnpm enrich:words      # fill words.details (RU translations, forms, examples) for un-enriched words
pnpm enrich:words:plan # dry-run: print what would be enriched, make zero LLM calls
pnpm check:shared      # property checks for packages/shared (URL round-trip, list helpers)
```

**pnpm 11+ is required and pnpm 9 fails silently.** `pnpm-workspace.yaml` carries `nodeLinker:
hoisted` and `hoistingLimits: workspaces`; pnpm 9 treats those as unknown keys and ignores them
without warning, producing a symlinked layout that breaks React Native tooling later. Verify with
`pnpm config get node-linker` → must print `hoisted`.

## Conventions

- **Secrets stay server-side.** `ANTHROPIC_API_KEY`, `xi-api-key`, and the Supabase
  service-role key never reach the browser. Only `NEXT_PUBLIC_*` values are client-visible.
- **Ownership is enforced in code.** Every Supabase query filters/stamps `owner_id` (the
  Auth0 `sub`); RLS is defense-in-depth (see `supabase/README.md`).
- **`packages/shared` (`@tutor/shared`) is the pure core; dependencies point inward only.** It holds
  the shapes and rules that any client must agree on — DTOs (`word-types.ts`, `lesson-types.ts`), the
  items-page query grammar (`items-query.ts`), and the tutor wire contract (`tutor.ts`:
  `formatItemsList`, `KICKOFF_MESSAGE`, `TranscriptLine`, …). Import it by name and by module:
  `import { … } from "@tutor/shared/word-types"`, never by a relative path.
  **Nothing in `packages/shared/src/` may import from an app or from an npm package** — the
  app→shared direction only. Both halves are enforced by `no-restricted-imports` in
  `packages/shared/eslint.config.js`: one pattern blocks `lib`/`app` paths, the other blocks every
  bare specifier. `dependencies` is empty and must stay empty. `apps/web/src/lib/` keeps the I/O
  (Supabase queries, LLM calls, Next plumbing) and imports the shapes from the package; a server-only
  detail such as the `SortKey → column` map stays in `lib/`.
  **Two tsconfigs, deliberately.** `packages/shared/tsconfig.json` covers `src/**` with `types: []`
  and no `DOM.Iterable`, so the core's portability is a compile-time guarantee — a `node:*` import
  there is a hard error even though `@types/node` is installed. `tsconfig.check.json` covers
  `check.ts`, which is a Node CLI script and lives _beside_ `src/` for exactly that reason. Adding a
  Node-only or npm-dependent module to `src/` is not a thing to be talked out of; it will not compile.
  **A future `apps/mobile` depends on this package; it must never copy from it.** The whole point of
  the workspace is that one protocol has one implementation — a copied `KICKOFF_MESSAGE` or
  `sanitizeTranscript` produces a _working_ session with a silently polluted transcript, noticed weeks
  later. The test for anything you are tempted to add here: _if this had a bug, could I fix it by
  deploying the web app alone?_ If yes it belongs on the server and the client should call it over
  HTTP; only logic both sides must change simultaneously belongs in the package.
  See `docs/2026-08-09-shareable-core-refactor.md` (why each piece qualified) and
  `docs/2026-08-09-expo-repo-structure-migration.md` (the workspace, and the rule for what may be
  added later).
- **The `/lesson-items` URL is the filter state, and its grammar has exactly one implementation.**
  `packages/shared/src/items-query.ts` owns both directions (`parseItemsQuery` / `serializeItemsQuery`) and the
  whitelists that keep arbitrary strings out of PostgREST. Encoder and decoder read the same
  `DEFAULT_SORT` / `DEFAULT_DIR` constants — they previously lived in two files with two different
  defaults, which made the "Times practiced" sort silently unselectable. `pnpm check:shared`
  exhaustively verifies `parse ∘ serialize == identity` (10,752 cases); run it after touching that
  module. Free-text search (`?q=`) is deliberately _not_ in `ItemsQuery`: filters and sort go to
  Postgres, and `searchItems` (`packages/shared/src/item-list.ts`) filters the loaded list in memory — it
  returns the input array _identity_ for an empty term, which the list's `useMemo` depends on.
- **The HTTP contract is declared in `packages/shared/src/api.ts`** — route paths (`API_ROUTES`,
  `signedUrlPath`), response bodies, the `ApiErrorBody` envelope, and the `isApiError` /
  `isSignedUrlResponse` guards. Routes assign their body to the declared type before returning, and
  `apps/web/src/lib/http.ts` builds the envelope through it, so a drifted field fails typecheck. Clients narrow
  with the guards rather than re-declaring shapes inline. **`appEnv` is required, never defaulted**:
  it becomes the `app_env` dynamic variable the post-call webhook routes on, so a missing one must
  error rather than silently file a dev session under prod.
- **The offline outbox's op algebra and write rules live in `packages/shared/src/sync-ops.ts`**, not in the
  engine. `apps/web/src/lib/sync/engine.ts` is browser-only (`getDb()`), so a Server Action cannot import from
  it — which is why `MAX_ITEMS` used to be declared on both sides and the title cap in three files.
  Both write paths (`createLessonLocal`, `addItemsLocal`) build their mirror rows **from the op**
  they queue, via `planNewItems`, so the optimistic view and the queued intent can't disagree.
  Positions continue from `max(existing.position) + 1` — a removed item leaves a gap and reusing a
  position would collide. Id minting and the clock are parameters (`newId`, `date`), never ambient
  globals, so the rules stay portable and deterministically testable.
- **The mirror is behind a storage contract; Dexie lives in three files.** `packages/shared/src/mirror-store.ts`
  declares `MirrorStore` (reads, writes, `transact`, `journal`); `apps/web/src/lib/sync/dexie-store.ts` implements
  it over the schema in `apps/web/src/lib/sync/db.ts`; `apps/web/src/lib/sync/live.ts` holds the three reactive hooks
  (`useMirrorLessons`, `useMirrorLesson`, `useMirrorItems`). Nothing else imports Dexie — `engine.ts`,
  `mirror.ts`, `session-journal.ts` and every component talk to the contract. **Reactivity is
  deliberately not abstracted**: Dexie's `liveQuery` rides IndexedDB's own mutation events and has no
  honest generic equivalent, so it stays per-platform in `live.ts`. Port surface = one `MirrorStore`
  - three hooks. Any mirror write and its outbox record must go in the same `transact` — that
    invariant is why the UI can never show a change whose intent was not queued.
- **LLM access goes through LangChain.** `apps/web/src/lib/llm.ts` builds a `ChatAnthropic`
  (`@langchain/anthropic`) defaulting to `claude-opus-4-5` (override with `ANTHROPIC_MODEL`).
  With `LANGSMITH_API_KEY` set, calls auto-trace to LangSmith.
- **Tutor prompts are a versioned source registry** (`apps/web/src/agent/prompts/` — one self-describing
  module per version). The filesystem is the source of truth; `pnpm sync:agents` reconciles
  ElevenLabs to match (create / update-in-place / retire) and records each version's agent id in
  the committed `apps/web/src/agent/agents.lock.json`. The runtime/UI read the lockfile via
  `apps/web/src/lib/agent-registry.ts`; a lesson page (`/lessons/[id]`) lets you pick a version per
  session. After adding,
  editing, or deleting a prompt version, run `pnpm sync:agents` and commit the lockfile. See
  `docs/2026-06-27-agent-prompt-version-switching.md`.
- **The vocabulary is `words`; lessons reference it many-to-many.** A word is owned by the learner,
  not by a lesson: `words` holds the text, its `norm_key` identity, and its attributes, and
  `lesson_items` is the join table (`lesson_id` + `word_id` + `position`). A word in no lesson is a
  normal state — either added directly on `/lesson-items` or removed from every lesson it was in.
  `norm_key` needs Postgres (unaccent + NFKC), so text → word id always goes through the
  `resolve_words` RPC in `apps/web/src/lib/words.ts`, never a client-side guess. See
  `docs/2026-07-16-add-word-on-lesson-items-page.md`.
  Every client-side normalization lives in `packages/shared/src/word-key.ts` — `wordInputKey` (what gets
  sent) and `clientDedupeKey` (optimistic UI only). `clientDedupeKey` is **deliberately weaker**
  than the Postgres identity: it may merge less than `norm_key`, never more, because merging less
  only leaves a duplicate for the server to skip while merging more would silently drop a word the
  learner typed. That is why the `linked` set in `linkWords` is load-bearing — do not remove it on
  the grounds that "the client already deduped".
- **CEFR levels are written only by the level job**, never by the UI. `words.level`
  is filled in by `apps/web/src/lib/levels.ts`, triggered two ways: `after()` on the word-write paths (fast)
  and `pnpm level:items` (the sweep that backfills and catches what the fast path dropped).
  `level_at` is the processed flag — it is stamped when the job **attempted** an item, not when it
  succeeded, so an item the model had no answer for is asked about once rather than on every
  sweep. `level` is nullable forever ("unleveled" is a real state), so the job has no deadline and
  the app needs no scheduler. See `docs/2026-07-16-level-assignment-background-job.md` (written
  against the pre-0007 `lesson_item_attrs` table; the design is unchanged, the columns moved).
- **Word details (`words.details`) are written only by the enrichment job**, never by the UI — the
  level job's machinery a second time. `apps/web/src/lib/word-details.ts` asks the LLM for a per-word payload
  (RU translations, part of speech, word-family forms with their translations, example sentences),
  triggered two ways: `after()` on the word-write paths (fast) and `pnpm enrich:words` (the sweep).
  `details_at` is the ATTEMPTED flag (stamped whether or not a payload came back, so an un-enrichable
  item is asked about once, not every sweep); `details` is nullable forever. Batches are small (4)
  because each answer is a large object — a big batch truncates and loses data. The word detail page
  (`/lesson-items/[id]`) renders it; `getItem` reads `details` with its own narrow query so the list
  view stays lean. See `docs/2026-07-18-word-details-enrichment-job.md`.
- **A voice session is foreground-only, and the UI must say so.** iOS revokes the microphone,
  interrupts Web Audio and drops the socket the moment Safari leaves the foreground, so a browser
  session cannot run in the background at all — `docs/2026-08-12-expo-app-creation.md` is the native
  way out (it supersedes the hybrid-shell proposal in `docs/2026-08-07-Expo-migration.md`). What the
  app owes the learner instead is that the session never dies quietly while the tab is open:
  `useKeepAwake` holds the screen (we pass `useWakeLock: false` — the SDK swallows its own wake-lock
  failures), `useAudioHealth` catches an interrupted audio graph that would otherwise look
  connected, hiding the page for more than 2s ends the session on purpose, and every transcript line
  is journalled to the mirror DB and beaconed to `/api/lessons/session` before iOS can discard the
  tab. Transcript writes go through `apps/web/src/lib/tutor-session.ts` — the action, the beacon
  route and the post-call webhook all upsert the same conversation_id row. **All of them sanitize
  through `sanitizeTranscript`** (`packages/shared/src/tutor.ts`, 500 lines / 4000 chars) so the
  row's content doesn't depend on which writer landed last — the webhook used to skip the caps
  entirely. The beacon trims client-side before sending, because `sendBeacon` has a payload ceiling
  and an over-large body loses the whole transcript. See
  `docs/2026-08-07-ios-keep-session-alive-foreground.md`.
- **Research documents live in `docs/` as Markdown.** Keep every research note in the `docs/`
  folder in Markdown format, and include the date in the file name (e.g.
  `docs/2026-06-26-topic.md`) so the research history stays traceable.
