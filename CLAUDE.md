# eleven-labs-english-agent Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-06-06

## Active Technologies

- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · Mastra (generation workflow) · `@anthropic` Claude (generation brain) · ElevenLabs `@elevenlabs/elevenlabs-js` (server, Text to Dialogue / Eleven v3) + `@elevenlabs/react` (client playback) · Supabase JS (`@supabase/supabase-js`, Postgres + Storage) · Auth0 (`@auth0/nextjs-auth0`) · Zod (shared schemas) · LangSmith via `@mastra/langsmith` (eval/observability) (002-lesson-generation)

## Project Structure

```text
packages/contracts/   # shared Zod schemas + DTOs (subsystem boundary)
packages/generator/   # lesson generation: adapters, prompts, workflow, evals
apps/web/             # Next.js App Router app: UI, API routes, Supabase persistence
supabase/migrations/  # Postgres schema, RLS, storage
```

## Commands

```bash
pnpm test            # unit + contract + integration (Vitest), providers mocked
pnpm typecheck       # strict TS across packages
pnpm lint            # ESLint flat config
pnpm eval:generation # generation-quality gate (coverage/two-voice/story/length); live with keys, else mocks
pnpm test:e2e        # Playwright submit→generate→replay, desktop + mobile (needs `npx playwright install chromium`)
pnpm smoke:generate  # one real Claude + ElevenLabs lesson to /tmp/idiomatic-smoke.mp3
```

Before committing feature work: `pnpm test && pnpm typecheck && pnpm lint`.

## Code Style

TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II): Follow standard conventions

## Recent Changes

- 002-lesson-generation: Added TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · Mastra (generation workflow) · `@anthropic` Claude (generation brain) · ElevenLabs `@elevenlabs/elevenlabs-js` (server, Text to Dialogue / Eleven v3) + `@elevenlabs/react` (client playback) · Supabase JS (`@supabase/supabase-js`, Postgres + Storage) · Auth0 (`@auth0/nextjs-auth0`) · Zod (shared schemas) · LangSmith via `@mastra/langsmith` (eval/observability)

<!-- MANUAL ADDITIONS START -->

## Generation architecture note

Generation is implemented as a plain `generateLesson` orchestrator
(`packages/generator/src/index.ts`), not a Mastra runtime. LangSmith traceability is wired
directly via the `langsmith` SDK in `packages/generator/src/workflow/tracing.ts`
(`generateLessonTraced`), used by the web app's generation runner. The `@mastra/langsmith`
exporter from plan.md was superseded because there is no Mastra trace stream to export.
LangSmith is a soft dependency — everything degrades to a no-op without `LANGSMITH_API_KEY`.

<!-- MANUAL ADDITIONS END -->
