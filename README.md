# Idiomatic

A minimal **Next.js (App Router)** scaffold — a clean starting point for rebuilding the
Idiomatic English-lesson app. It keeps just enough to prove the four integrations work, and
nothing else. The original product vision lives in [`spec/PRD-base.md`](./spec/PRD-base.md).

## What's wired

| Piece | Where | Proven by |
| --- | --- | --- |
| **Auth0** login + route gating | `src/proxy.ts`, `src/lib/auth0.ts` | the dashboard shows your signed-in email |
| **Supabase** (owner-scoped rows + RLS) | `src/lib/supabase/*`, `supabase/migrations/` | insert/read an owner-scoped `health_pings` row |
| **ElevenLabs** live-story agent | `src/agent/*` | `GET /v1/user` health check + `pnpm provision:agent` |
| **LangChain + Claude** | `src/lib/llm.ts` | the "Ask Claude" box (auto-traces to LangSmith) |

The home page (`/`) is an integration smoke test surfacing the health of each.

## Setup

```bash
cp .env.example .env.local      # fill in Auth0 / Supabase / Anthropic / ElevenLabs keys
pnpm install
pnpm db:migrate                 # apply the baseline schema (needs SUPABASE_DB_URL)
pnpm dev                        # http://localhost:3000
```

Sign in (Auth0 gates everything), then use the dashboard to confirm each integration.

## Commands

```bash
pnpm dev               # run the app
pnpm build             # production build
pnpm typecheck         # strict TypeScript
pnpm lint              # ESLint
pnpm db:migrate        # apply Supabase migrations
pnpm provision:agent   # create the ElevenLabs live-story agent (prints the agent id)
```

## Layout

```text
src/app/    UI (smoke-test dashboard), server actions, /api/health
src/lib/    auth0, supabase clients, config, health checks, LangChain LLM
src/agent/  ElevenLabs live-story agent: versioned prompt + provisioning script
supabase/   Postgres migrations (owner-scoped RLS)
scripts/    migrate.mjs
```

## Notes

- Secrets stay server-side; only `NEXT_PUBLIC_*` env reaches the browser.
- Supabase uses the **same project** as before — the data was reset to a fresh baseline
  (`supabase/migrations/0001_baseline.sql`).
- The LLM defaults to `claude-opus-4-8` (override with `ANTHROPIC_MODEL`).
