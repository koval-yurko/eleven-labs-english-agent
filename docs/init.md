# Idiomatic — Init Snapshot

> Current state of the scaffold as of 2026-06-26. This documents **what exists today**, not
> the full product vision (that lives in `spec/PRD-base.md`).

A minimal **Next.js (App Router)** scaffold (`idiomatic`, private, `0.0.0`) that proves four
integrations are wired and working. The home page is an integration smoke test; it is not the
finished product.

## Tech stack

| Layer            | Choice                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| Language         | TypeScript 5.7 (strict + `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) |
| Runtime          | Node ≥ 20 LTS, ESM (`"type": "module"`)                                 |
| Package manager  | pnpm 9.15.4 (single package, no workspace)                             |
| Framework        | Next.js 16 (App Router), React 19                                      |
| Auth             | Auth0 — `@auth0/nextjs-auth0` v4                                        |
| Database         | Supabase (Postgres) — `@supabase/supabase-js` v2, owner-scoped + RLS   |
| Voice / agent    | ElevenLabs Conversational AI (live-story agent, provisioned via API)   |
| LLM              | Anthropic Claude via LangChain — `@langchain/anthropic` + `@langchain/core` |
| Tracing / evals  | LangSmith (auto-trace through LangChain when env is set)               |
| Tooling          | ESLint 9 (flat config) + typescript-eslint, Prettier 3, tsx, `pg` (migrations) |

Default Claude model: `claude-opus-4-8` (override with `ANTHROPIC_MODEL`).

## Commands

```bash
pnpm dev               # run the app (http://localhost:3000)
pnpm build             # production build
pnpm start             # serve the production build
pnpm typecheck         # strict TS (tsc --noEmit)
pnpm lint              # ESLint flat config
pnpm format            # prettier --write .
pnpm db:migrate        # apply Supabase migrations (needs SUPABASE_DB_URL)
pnpm db:migrate:status # show applied/pending migrations
pnpm provision:agent   # create the ElevenLabs live-story agent; prints ELEVENLABS_STORY_AGENT_ID
```

## Layout

```text
src/
  app/
    layout.tsx          # root layout, header, metadata, globals.css
    page.tsx            # integration smoke-test dashboard (server component)
    globals.css         # global styles (panels, status dots)
    actions.ts          # server actions: addPing(), askClaudeAction()
    AskClaude.tsx       # client form (useActionState) for the Claude call
    api/health/route.ts # GET /api/health — machine-readable integration health
  lib/
    auth0.ts            # Auth0Client construction from AUTH0_* env
    auth/session.ts     # getOwnerId(), getUserEmail(), getAuthToken()
    supabase/server.ts      # getServiceSupabase() (service-role, server-only)
    supabase/user-client.ts # getUserSupabase() (token-scoped RLS; dormant)
    config.ts           # elevenLabsConfig(env)
    health.ts           # checkSupabase/ElevenLabs/Anthropic
    http.ts             # json() / apiError() / unauthorized() helpers
    llm.ts              # getChatModel(), askClaude() — ChatAnthropic
  agent/
    agent-prompt.ts     # versioned live-story system prompt + client-tool descriptions
    create-agent.ts     # provisioning script (POST /v1/convai/agents/create)
  proxy.ts              # Next 16 proxy/middleware — Auth0 route gate
supabase/
  migrations/0001_baseline.sql  # health_pings table + RLS
  README.md             # access paths + Auth0 third-party trust setup
scripts/migrate.mjs     # forward-only migration runner (schema_migrations table)
spec/PRD-base.md        # full product vision (aspirational reference)
docs/                   # research notes (date-stamped Markdown)
```

## What works today (functionality)

The home page (`src/app/page.tsx`) renders a dashboard that exercises every integration:

1. **Auth0 login gating.** `src/proxy.ts` redirects unauthenticated page requests to
   `/auth/login`; `/auth/*` and `/api/*` pass through (APIs return 401 JSON themselves).
   Owner identity = Auth0 `sub`.
2. **Status panel.** Live colored-dot health for Auth0 / Supabase / ElevenLabs /
   LangChain+Claude, with links to `/auth/logout` and `/api/health`.
3. **Supabase write test.** A form posts to the `addPing` server action, inserting an
   owner-scoped `health_pings` row; the 5 most recent pings for the owner are listed.
4. **Ask Claude.** The `AskClaude` client component calls `askClaudeAction`, which runs
   `askClaude()` through LangChain `ChatAnthropic` (auto-traced to LangSmith when configured).
5. **Health endpoint.** `GET /api/health` returns `{ auth, supabase, elevenlabs, anthropic }`
   as JSON — 200 if all green, 503 otherwise.
6. **Agent provisioning.** `pnpm provision:agent` creates the ElevenLabs Conversational AI
   live-story agent (pinned teacher voice, native Claude LLM, versioned system prompt, four
   client tools, five dynamic variables) and prints its `agent_id`.

### ElevenLabs live-story agent

- Prompt version: `live-story-1.0` (`src/agent/agent-prompt.ts`).
- Client tools (all `expects_response`, 10s timeout): `advanceNarration`, `markItemTaught`,
  `setScenario`, `concludeLesson`.
- Dynamic variables: `lesson_summary`, `items_list`, `beats_outline`, `target_minutes`,
  `scenario`.
- Provisioning overrides: `LIVE_STORY_LLM` (default `claude-haiku-4-5`), `LIVE_STORY_TTS_MODEL`
  (default `eleven_flash_v2`).

## Database schema

`supabase/migrations/0001_baseline.sql` (fresh baseline) creates:

- **`health_pings`** — `id uuid PK`, `owner_id text` (Auth0 sub), `note text`,
  `created_at timestamptz`; index on `(owner_id, created_at desc)`.
- RLS enabled with owner-scoped select/insert policies (`owner_id = auth.jwt() ->> 'sub'`).
- `schema_migrations` — bookkeeping table maintained by the migration runner.

Ownership is enforced **in code** (every query filters/stamps `owner_id`); RLS is
defense-in-depth and stays dormant until Auth0 third-party trust is configured
(see `supabase/README.md`).

## Environment variables

| Variable | Purpose | Visibility |
| --- | --- | --- |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, `APP_BASE_URL` | Auth0 session | server |
| `AUTH0_AUDIENCE` (optional) | enables JWT access tokens for Supabase RLS | server |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase client | public |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role DB access | server |
| `SUPABASE_DB_URL` (or `DATABASE_URL`) | migration runner | server |
| `ELEVENLABS_API_KEY` | `xi-api-key` header | server |
| `ELEVENLABS_TEACHER_VOICE_ID`, `ELEVENLABS_STORY_AGENT_ID` | pinned voice + provisioned agent | server |
| `LIVE_STORY_LLM`, `LIVE_STORY_TTS_MODEL` (optional) | provisioning overrides | server |
| `ANTHROPIC_API_KEY` | Claude access | server |
| `ANTHROPIC_MODEL` (optional, default `claude-opus-4-8`) | model override | server |
| `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` (default `idiomatic`), `LANGCHAIN_TRACING_V2` | tracing | server |

See `.env.example` for the authoritative list. Secrets stay server-side; only `NEXT_PUBLIC_*`
values reach the browser.
