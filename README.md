# English Tutor

A minimal **Next.js (App Router)** scaffold — a clean starting point for rebuilding the
English Tutor English-lesson app. It keeps just enough to prove the four integrations work, and
nothing else. The original product vision lives in [`spec/PRD-base.md`](./spec/PRD-base.md).

## What's wired

| Piece                                  | Where                                                 | Proven by                                        |
| -------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| **Auth0** login + route gating         | `apps/web/src/proxy.ts`, `apps/web/src/lib/auth0.ts`  | the dashboard shows your signed-in email         |
| **Supabase** (owner-scoped rows + RLS) | `apps/web/src/lib/supabase/*`, `supabase/migrations/` | insert/read an owner-scoped `health_pings` row   |
| **ElevenLabs** tutor agents            | `apps/web/src/agent/*`                                | `GET /v1/user` health check + `pnpm sync:agents` |
| **LangChain + Claude**                 | `apps/web/src/lib/llm.ts`                             | the "Ask Claude" box (auto-traces to LangSmith)  |

The home page (`/`) is an integration smoke test surfacing the health of each.

## Setup

This is a **pnpm workspace**. Run every command from the repo root — the root scripts delegate to the
right package, so nothing needs a `cd`.

```bash
cp apps/web/.env.example apps/web/.env   # Auth0 / Supabase / Anthropic / ElevenLabs keys
pnpm install                             # needs pnpm 11+ (see below)
pnpm db:migrate                          # apply the baseline schema (needs SUPABASE_DB_URL)
pnpm dev                                 # http://localhost:3000
```

Sign in (Auth0 gates everything), then use the dashboard to confirm each integration.

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
pnpm dev               # run the app
pnpm build             # production build
pnpm typecheck         # strict TypeScript, every package
pnpm lint              # ESLint, every package
pnpm check:shared      # property checks for packages/shared
pnpm db:migrate        # apply Supabase migrations
pnpm sync:agents       # reconcile ElevenLabs with apps/web/src/agent/prompts/
pnpm level:items       # assign CEFR levels to unleveled vocabulary
pnpm enrich:words      # fill words.details for un-enriched words
```

The last four have `:plan` / `:status` variants that change nothing and print what they would do.

## Layout

```text
apps/web/           the Next.js app
  src/app/          UI, server actions, /api/*
  src/lib/          auth0, supabase clients, config, health, LangChain LLM, offline sync
  src/agent/        ElevenLabs tutor agents: versioned prompts + agents.lock.json
  scripts/          migrate.mjs, level-items.ts, enrich-words.ts
packages/shared/    @tutor/shared — the pure core both clients must agree on (zero deps)
supabase/           Postgres migrations (owner-scoped RLS) — repo-level, both apps share the DB
docs/  spec/        research notes and the product vision — repo-level
```

`packages/shared` exists so a future `apps/mobile` (Expo) can depend on the same wire contract
instead of copying it. See [`docs/2026-08-09-expo-repo-structure-migration.md`](./docs/2026-08-09-expo-repo-structure-migration.md).

## Notes

- Secrets stay server-side; only `NEXT_PUBLIC_*` env reaches the browser.
- Supabase uses the **same project** as before — the data was reset to a fresh baseline
  (`supabase/migrations/0001_baseline.sql`).
- The LLM defaults to `claude-opus-4-5` (override with `ANTHROPIC_MODEL`).

Grafana Traces for LLM calls
