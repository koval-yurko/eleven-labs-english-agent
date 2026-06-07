# eleven-labs-english-agent Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-06-07

## Active Technologies
- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + No new runtime dependency. A minimal in-repo structured logger (interface + JSON-line emitter + redaction) added to `packages/generator`; consumed by `apps/web` (which already depends on `@idiomatic/generator`). Existing stack unchanged (Next.js · Mastra-free `generateLesson` orchestrator · Claude/ElevenLabs adapters · Supabase · Auth0 · Zod · LangSmith soft-dep). (003-internal-logging)
- N/A. Logs are emitted to the process standard output stream (FR-016); nothing is persisted to Postgres or Storage. The lesson lifecycle states being logged already persist via S1. (003-internal-logging)
- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + No new runtime dependency. A minimal in-repo `mapWithConcurrency` (004-tts-parallel-render)
- N/A. No persistence change. The stitched `RenderedAudio` artifact and the lesson status (004-tts-parallel-render)
- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · **ElevenLabs Agents / Conversational AI** via `@elevenlabs/react` (client realtime session: WebRTC/WebSocket, VAD, barge-in, STT→TTS) + ElevenLabs REST (`/v1/convai/conversation/token`, server-side token mint) · **native Claude** as the agent LLM (configured in the agent, no custom proxy) · existing `@idiomatic/contracts` (Zod) · Supabase JS (Postgres + RLS) · Auth0 (`@auth0/nextjs-auth0`) · the existing in-repo structured logger (`@idiomatic/generator` observability port). Reuses the existing pinned ElevenLabs teacher voice from 002. (005-live-tutor-qa)
- Supabase Postgres — two new owner-scoped tables `qa_exchanges` and `qa_turns` (transcript record), RLS keyed on the Auth0 subject like `lessons`. No new Storage bucket. Live answer **audio is not persisted** in v1 (the text transcript is the durable record); the realtime audio is ephemeral session output. (005-live-tutor-qa)

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
- 005-live-tutor-qa: Added TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · **ElevenLabs Agents / Conversational AI** via `@elevenlabs/react` (client realtime session: WebRTC/WebSocket, VAD, barge-in, STT→TTS) + ElevenLabs REST (`/v1/convai/conversation/token`, server-side token mint) · **native Claude** as the agent LLM (configured in the agent, no custom proxy) · existing `@idiomatic/contracts` (Zod) · Supabase JS (Postgres + RLS) · Auth0 (`@auth0/nextjs-auth0`) · the existing in-repo structured logger (`@idiomatic/generator` observability port). Reuses the existing pinned ElevenLabs teacher voice from 002.
- 004-tts-parallel-render: Added TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + No new runtime dependency. A minimal in-repo `mapWithConcurrency`
- 003-internal-logging: Added TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + No new runtime dependency. A minimal in-repo structured logger (interface + JSON-line emitter + redaction) added to `packages/generator`; consumed by `apps/web` (which already depends on `@idiomatic/generator`). Existing stack unchanged (Next.js · Mastra-free `generateLesson` orchestrator · Claude/ElevenLabs adapters · Supabase · Auth0 · Zod · LangSmith soft-dep).


<!-- MANUAL ADDITIONS START -->

## Generation architecture note

Generation is implemented as a plain `generateLesson` orchestrator
(`packages/generator/src/index.ts`), not a Mastra runtime. LangSmith traceability is wired
directly via the `langsmith` SDK in `packages/generator/src/workflow/tracing.ts`
(`generateLessonTraced`), used by the web app's generation runner. The `@mastra/langsmith`
exporter from plan.md was superseded because there is no Mastra trace stream to export.
LangSmith is a soft dependency — everything degrades to a no-op without `LANGSMITH_API_KEY`.

## Internal logging note (003-internal-logging)

The generation pipeline is observable via a small, dependency-free structured logger in
`packages/generator/src/observability/` (typed `Logger` port + NDJSON `JsonLogger` +
no-op default + secret redaction). It is an **injected** port: the generator defaults to
`noopLogger`, and the web bridge (`apps/web/lib/generation/runner.ts`,
`lib/lessons/service.ts`) mints a child logger bound to `{ lessonId, ownerId }` so every
entry for a run shares its id. Config via `LOG_LEVEL` (default `info`) and `LOG_PRETTY`.
Raw learner text / draft bodies are gated to `debug` (Constitution V); secrets are always
redacted; emits are best-effort and never throw into generation. When adding a pipeline
stage, add its `EventId` to `observability/events.ts` and emit through the injected logger —
never `console.log`.

<!-- MANUAL ADDITIONS END -->
