# English Tutor

An English tutor: a learner collects vocabulary and practises it in a live voice lesson. The
product is the iOS app; everything else is a backend it talks to over HTTP, or a web client of that
same backend. The original product vision lives in [`spec/PRD-base.md`](./spec/PRD-base.md); the
current shape of the repo is [`docs/2026-10-10-services-split-hono-api.md`](./docs/2026-10-10-services-split-hono-api.md).

## What's wired

| Piece                                  | Where                                                         |
| -------------------------------------- | ------------------------------------------------------------- |
| **Auth0** — bearer tokens for the API  | `packages/server/src/auth/bearer.ts`, `services/api/src/lib/auth/` |
| **Auth0** — web login (two web apps)   | `apps/tutor-web/src/lib/auth0.ts`, `apps/feedback-tracker/src/lib/auth0.ts` |
| **Supabase** (owner-scoped rows + RLS) | `packages/server/src/supabase/server.ts`, `supabase/migrations/` |
| **ElevenLabs / Vapi** tutor agents     | `packages/server/src/agent/*` + `pnpm sync:agents`            |
| **LiveKit** tutor (our own pipeline)   | `services/voice-worker/`                                      |
| **LangChain + Claude** background jobs | `packages/server/src/llm.ts` (traced to LangSmith)            |

`GET /api/health` reports the state of each dependency.

## Setup

This is a **pnpm workspace**. Run every command from the repo root — the root scripts delegate to the
right package, so nothing needs a `cd`.

```bash
cp services/api/.env.example services/api/.env   # the backend's keys (the CLI jobs read it too)
pnpm install                                     # needs pnpm 11+ (see below)
pnpm db:migrate                                  # apply the schema (needs SUPABASE_DB_URL)
pnpm dev                                         # services/api on http://localhost:3000
```

The web apps each have their own `.env.example` (Auth0 web-app settings + `API_BASE_URL`, no
server secrets): `pnpm dev:tutor-web` (:3002) and `pnpm dev:feedback` (:3003), with `pnpm dev`
running. The phone app is `pnpm mobile`.

**pnpm 11 is required, and the failure is silent if you are on 9.** `pnpm-workspace.yaml` carries the
linker settings, which pnpm 9 reads as unknown keys and ignores without warning. Check with
`pnpm config get node-linker` — it must print `hoisted`.

## Code map (graphify)

```bash
uv tool install "graphifyy[sql]"   # without the [sql] extra, supabase/migrations/*.sql
                                    # silently contributes nothing to the graph
```

The `[sql]` extra is not optional the way it might look — without it, every SQL migration
(the RLS-guarded `words`/`lesson_items` schema, every server-only RPC) is silently absent from
the graph, with a `.sql file(s) contributed nothing` warning easy to miss. See
[`docs/2026-09-19-graffiti-to-graphify-design.md`](./docs/2026-09-19-graffiti-to-graphify-design.md) §3.

```bash
graphify update .                        # code only, no LLM, run after editing code
graphify query "resolve_words"           # scoped subgraph, e.g. finds the RPC at
                                          # supabase/migrations/0007_words_m2m.sql:102
graphify explain "resolveWords"          # plain-language explanation of one symbol
graphify path "words" "lesson_items"     # shortest path between two nodes
graphify god-nodes                       # most-connected nodes (architectural hubs)
```

Docs only reach the graph through a semantic (LLM) pass, and the result is cached and committed
so nobody re-pays for it:

```bash
graphify extract . --backend claude-cli
git add graphify-out/cache/semantic/
```

CI regenerates that cache on `master` too (`.github/workflows/graphify-semantic-cache.yml`), so
the manual command above is a convenience, not an obligation — if CI already ran, `git pull`
picks up the refreshed cache for free.

**The git hooks that keep the graph current after commits/checkouts don't fire inside a linked
git worktree.** From a worktree, run `graphify update .` by hand.

## Commands

```bash
pnpm dev               # services/api, the backend
pnpm build             # production builds: services/api, tutor-web, feedback-tracker
pnpm typecheck         # strict TypeScript, every package
pnpm lint              # ESLint, every package
pnpm check:shared      # property checks for packages/shared
pnpm db:migrate        # apply Supabase migrations
pnpm sync:agents       # reconcile ElevenLabs with packages/server/src/agent/prompts/
pnpm level:items       # assign CEFR levels to unleveled vocabulary
pnpm enrich:words      # fill words.details for un-enriched words
```

The last four have `:plan` / `:status` variants that change nothing and print what they would do.

## Layout

```text
apps/                    clients — things a person opens
  mobile/                Expo iOS app — the product
  tutor-web/             Next.js learner web UI (deprecated) — HTTP client of services/api
  feedback-tracker/      Next.js debug-report triage for the operator — HTTP client of services/api
services/                backends — things that run on a server
  api/                   Hono HTTP API on Vercel: every /api/** route, webhooks, MCP
  voice-worker/          LiveKit tutor agent on LiveKit Cloud
packages/
  shared/                @tutor/shared — the pure core every app and service agrees on (zero deps)
  server/                @tutor/server — backend domain core: data access, jobs, agent registry, CLI scripts
supabase/                Postgres migrations (owner-scoped RLS) — repo-level
docs/  spec/             research notes and the product vision — repo-level
```

## Notes

- Secrets stay in `services/api` (and the CLI jobs that share its `.env`); no client holds one.
- Supabase uses the **same project** as before — the data was reset to a fresh baseline
  (`supabase/migrations/0001_baseline.sql`).
- The LLM defaults to `claude-opus-4-5` (override with `ANTHROPIC_MODEL`).

Grafana Traces for LLM calls
