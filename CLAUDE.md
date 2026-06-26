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

TypeScript (strict), Node 20 LTS, single pnpm package (no workspace).

## Layout

```text
src/
  app/          # Next.js App Router: layout, smoke-test dashboard, server actions, /api/health
  lib/          # auth0 + session, supabase (service & user clients), config, health, llm
  agent/        # ElevenLabs live-story agent: versioned prompt + provisioning script
supabase/
  migrations/   # Postgres schema (owner-scoped RLS) — applied via pnpm db:migrate
scripts/        # migrate.mjs (db migration runner)
spec/PRD-base.md  # the original product vision (reference)
```

## Commands

```bash
pnpm dev               # run the app (http://localhost:3000)
pnpm build             # production build
pnpm typecheck         # strict TS (tsc --noEmit)
pnpm lint              # ESLint flat config
pnpm db:migrate        # apply Supabase migrations (needs SUPABASE_DB_URL)
pnpm provision:agent   # create the ElevenLabs live-story agent; prints ELEVENLABS_STORY_AGENT_ID
```

## Conventions

- **Secrets stay server-side.** `ANTHROPIC_API_KEY`, `xi-api-key`, and the Supabase
  service-role key never reach the browser. Only `NEXT_PUBLIC_*` values are client-visible.
- **Ownership is enforced in code.** Every Supabase query filters/stamps `owner_id` (the
  Auth0 `sub`); RLS is defense-in-depth (see `supabase/README.md`).
- **LLM access goes through LangChain.** `src/lib/llm.ts` builds a `ChatAnthropic`
  (`@langchain/anthropic`) defaulting to `claude-opus-4-8` (override with `ANTHROPIC_MODEL`).
  With `LANGSMITH_API_KEY` set, calls auto-trace to LangSmith.
- **The ElevenLabs agent prompt is a versioned source artifact** (`src/agent/agent-prompt.ts`).
  Re-provision with `pnpm provision:agent` after editing it.
