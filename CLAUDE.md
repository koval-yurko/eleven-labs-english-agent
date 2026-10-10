# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## tutor-web is deprecated. Mobile is the product.

**`apps/mobile` (Expo / React Native, iOS) is the only client under active development.** Every new
feature is researched, designed and built from the mobile perspective — screens, navigation, offline
behaviour, UX. If a task says "add feature X", it means add it to the mobile app.

**`apps/tutor-web` (Next.js) is the deprecated learner web UI.** Do not build new screens there, and
do not spend effort on it beyond keeping it compiling. Like every client it reads data only through
`services/api` (`src/lib/api.ts`) and holds no server code or secrets.

**`apps/feedback-tracker` is the operator's debug-report triage, not part of the product** — so the
deprecation does not apply to it. It is never linked from a learner surface, and it reads EVERY
learner's reports (decision D10, an accepted risk). See `docs/2026-09-09-mobile-debug-reports-and-feedback.md`
§12 and `docs/2026-10-10-services-split-hono-api.md` §6.

**The backend is `services/api` (Hono on Vercel) over `packages/server` (`@tutor/server`)**, plus
`services/voice-worker` on LiveKit Cloud. Every client — the phone, tutor-web, feedback-tracker —
talks to the API over HTTP with an Auth0 bearer token; no client holds a server secret. The split
and its decisions: `docs/2026-10-10-services-split-hono-api.md`.

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
  tutor-web/         # Next.js — deprecated learner web UI; a client of services/api
  feedback-tracker/  # Next.js — operator's debug-report triage; a client of services/api
services/            # backends: things that run on a server, not something a person opens
  api/               # Hono HTTP API on Vercel — every /api/** route, webhooks, MCP; bundles to server.mjs
  voice-worker/      # LiveKit agent (Deepgram → Claude → TTS) — deployed to LiveKit Cloud, not Vercel
packages/
  shared/            # @tutor/shared — pure core, zero runtime deps, shared by every app and service
  server/            # @tutor/server — backend domain core: src/ (data, jobs, agent registry), scripts/
supabase/migrations/ # Postgres schema, applied via pnpm db:migrate
docs/                # research notes, date-stamped Markdown
spec/PRD-base.md     # original product vision (reference)
```

`supabase/`, `docs/` and `spec/` stay at the repo root on purpose — they span every app and service.

## Commands

Run everything from the repo root; each script delegates with `pnpm --filter`.

```bash
pnpm mobile            # Expo dev server (apps/mobile also has: pnpm check, ios, bundle)
pnpm dev               # services/api, the backend (http://localhost:3000)
pnpm dev:tutor-web     # apps/tutor-web (http://localhost:3002) — needs `pnpm dev` running
pnpm dev:feedback      # apps/feedback-tracker (http://localhost:3003) — needs `pnpm dev` running
pnpm parity:api --old <url> --new <url>   # compare two API deployments (read-only; --token-file for auth)
pnpm typecheck         # strict TS across every package
pnpm lint              # ESLint across every package
pnpm check:shared      # property checks for packages/shared
pnpm db:migrate        # apply Supabase migrations (needs SUPABASE_DB_URL); :status to inspect
pnpm sync:agents       # reconcile ElevenLabs agents with packages/server/src/agent/prompts/
pnpm level:items       # assign CEFR levels to unlevelled words
pnpm enrich:words      # fill words.details (RU translations, forms, examples)
pnpm lexicon:load      # load the lexicon; pnpm level:lexicon levels it
pnpm report <id>       # one debug report as Markdown; --list, --since 7d, --json
```

`pnpm report` is the handoff for a diagnostic report filed from the phone — read-only, and the
reason there is no read tool on the MCP server (`docs/2026-09-09-mobile-debug-reports-and-feedback.md`
§13). An 8-character id prefix is enough; it is what the app's Send tab tells the learner to quote.

Every job has a `:plan` variant that dry-runs and makes zero LLM calls. Before pushing mobile work,
run `pnpm --filter mobile check` (typecheck → lint → expo-doctor → bundle).

**pnpm 11+ is required; pnpm 9 fails silently** — it ignores the `nodeLinker: hoisted` /
`hoistingLimits` keys in `pnpm-workspace.yaml` and produces a symlinked layout that breaks React
Native tooling. Verify with `pnpm config get node-linker` → must print `hoisted`.

## Conventions

- **Secrets stay server-side.** `ANTHROPIC_API_KEY`, `xi-api-key` and the Supabase service-role key
  never leave `services/api` (and the CLI jobs that share its `.env`). Every client — the phone,
  tutor-web, feedback-tracker — gets data through authenticated API routes and holds none of them.
- **Ownership is enforced in code.** Every Supabase query filters/stamps `owner_id` (the Auth0
  `sub`); RLS is defense-in-depth (`supabase/README.md`). **One deliberate exception:** the
  `/api/v2/ops/debug-reports` endpoints read and write every learner's reports for
  feedback-tracker, via the `ALL_OWNERS` symbol in `packages/server/src/debug-reports.ts` — decision
  D10, an accepted risk while the operator is the only learner. Close it (an `OPS_OWNER_IDS`
  allowlist) before a second learner exists. `docs/2026-10-10-services-split-hono-api.md` §6.1.
- **`packages/shared` is the pure core; dependencies point inward only.** It holds what both clients
  must agree on: DTOs, the items-page query grammar, the HTTP contract (`api.ts`), the tutor wire
  contract, the offline op algebra, the mirror-store interface. Nothing in `src/` may import from an
  app or from any npm package — `no-restricted-imports` and a `types: []` tsconfig make that a
  compile error, and `dependencies` must stay empty. Import by name: `@tutor/shared/words/types`.
  The test for adding something here: _if this had a bug, could I fix it by deploying the web app
  alone?_ If yes, it belongs on the server. Mobile must never copy from this package.
  See `docs/2026-08-09-shareable-core-refactor.md`.
- **`packages/server` is the backend core; it is framework-free.** It may import `@tutor/shared`
  and server-side npm packages, never an app and never `next`, `hono`, `@vercel/functions` or React
  (`no-restricted-imports` in its `eslint.config.js`). Transport concerns are injected: post-response
  work takes a `Defer` (`src/defer.ts`) that the HTTP layer wires to `after()` or `waitUntil`. Only
  the API may depend on it — clients and the voice worker talk HTTP. Its CLI scripts load `.env`
  from the one place `scripts/env-home.mjs` names. Import by name: `@tutor/server/lessons`.
- **The data model: `words` is the vocabulary; lessons reference it many-to-many** via `lesson_items`
  (`lesson_id` + `word_id` + `position`). A word belongs to the learner, not a lesson, so a word in
  no lesson is a normal state. Word identity (`norm_key`) needs Postgres (unaccent + NFKC), so text →
  word id always goes through the `resolve_words` RPC, never a client-side guess. Client-side
  normalization lives in `packages/shared/src/words/key.ts` and is deliberately *weaker* than the
  Postgres identity — merging less only leaves a duplicate for the server to skip, merging more would
  silently drop a word the learner typed.
- **`words.level` and `words.details` are written only by background jobs**, never by the UI.
  Both run two ways: deferred on the write path (`scheduleWordJobs`, fast) and a sweep script (backfill). The `*_at`
  columns are ATTEMPTED flags, stamped whether or not the model answered, so an un-answerable word is
  asked about once rather than every sweep. Both columns are nullable forever, so the jobs have no
  deadline and the app needs no scheduler. See `docs/2026-07-16-level-assignment-background-job.md`
  and `docs/2026-07-18-word-details-enrichment-job.md`.
- **Tutor prompts are a versioned source registry** (`packages/server/src/agent/prompts/` — one module per
  version). The filesystem is the source of truth; `pnpm sync:agents` reconciles ElevenLabs to match
  and records each version's agent id in the committed `agents.lock.json`, which clients read via
  `@tutor/server/agent-registry`. After adding, editing or deleting a version, run the sync and commit the
  lockfile. See `docs/2026-06-27-agent-prompt-version-switching.md`.
- **LLM access goes through LangChain.** `packages/server/src/llm.ts` builds a `ChatAnthropic`
  defaulting to `claude-opus-4-5` (override with `ANTHROPIC_MODEL`); with `LANGSMITH_API_KEY` set,
  calls auto-trace to LangSmith.
- **Transcript writes are sanitized by one function.** The action, the beacon route and the two
  post-call webhooks (ElevenLabs and Vapi) all upsert the same `conversation_id` row and all pass
  through `sanitizeTranscript` (`packages/shared/src/tutor/session.ts`), so the stored row doesn't
  depend on which writer landed last. The same function is reused outside that path by
  `sanitizeDebugReport` to bound a report's `transcriptTail` — same posture, no conversation row.
- **Offline writes are mirror + outbox in one transaction.** A mirror write and its queued op go in
  the same `transact`, which is why the UI can never show a change whose intent wasn't queued. Op
  rules live in `packages/shared/src/offline/ops.ts` and the storage contract in `offline/mirror.ts`;
  today the only full implementation is Dexie (`apps/tutor-web/src/lib/sync/`) — mobile shares the types
  and keeps its own `expo-sqlite` session journal. Reactivity stays per-platform on purpose.
- **Research documents live in `docs/` as date-stamped Markdown** (e.g. `docs/2026-06-26-topic.md`)
  so the research history stays traceable.

## graphify code map

If `graphify-out/graph.json` exists, this repo has a graphify code map: tree-sitter AST over
`apps/`, `services/`, `packages/` and `supabase/migrations/`, plus an LLM semantic pass over `docs/`.
For questions about the codebase's structure (where something lives, how parts connect, the
architecture), run `graphify query "<question>"` instead of grep/read — it returns a scoped
subgraph. Use `graphify explain "<symbol>"` for one concept and `graphify path "A" "B"` for how
two things connect. Matching is case-folded substring with IDF (no stemming, no synonyms), so
query with the graph's own vocabulary — symbol and file names, not paraphrases. After editing
code, run `graphify update .` to refresh the map (AST-only, no LLM cost). SQL migrations need the
`graphifyy[sql]` extra installed, or `supabase/migrations/*.sql` silently drops out of the graph
(see `docs/2026-09-19-graffiti-to-graphify-design.md` §3). Docs/`.md` files reach the graph only
through `graphify extract .`, which calls an LLM — see that doc's §7 for the cache it commits.
