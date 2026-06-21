# eleven-labs-english-agent Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-06-07

## Active Technologies
- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + No new runtime dependency. A minimal in-repo structured logger (interface + JSON-line emitter + redaction) added to `packages/generator`; consumed by `apps/web` (which already depends on `@idiomatic/generator`). Existing stack unchanged (Next.js · Mastra-free `generateLesson` orchestrator · Claude/ElevenLabs adapters · Supabase · Auth0 · Zod · LangSmith soft-dep). (003-internal-logging)
- N/A. Logs are emitted to the process standard output stream (FR-016); nothing is persisted to Postgres or Storage. The lesson lifecycle states being logged already persist via S1. (003-internal-logging)
- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + No new runtime dependency. A minimal in-repo `mapWithConcurrency` (004-tts-parallel-render)
- N/A. No persistence change. The stitched `RenderedAudio` artifact and the lesson status (004-tts-parallel-render)
- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · **ElevenLabs Agents / Conversational AI** via `@elevenlabs/react` (client realtime session: WebRTC/WebSocket, VAD, barge-in, STT→TTS) + ElevenLabs REST (`/v1/convai/conversation/token`, server-side token mint) · **native Claude** as the agent LLM (configured in the agent, no custom proxy) · existing `@idiomatic/contracts` (Zod) · Supabase JS (Postgres + RLS) · Auth0 (`@auth0/nextjs-auth0`) · the existing in-repo structured logger (`@idiomatic/generator` observability port). Reuses the existing pinned ElevenLabs teacher voice from 002. (005-live-tutor-qa)
- Supabase Postgres — two new owner-scoped tables `qa_exchanges` and `qa_turns` (transcript record), RLS keyed on the Auth0 subject like `lessons`. No new Storage bucket. Live answer **audio is not persisted** in v1 (the text transcript is the durable record); the realtime audio is ephemeral session output. (005-live-tutor-qa)
- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · **ElevenLabs Agents / Conversational AI** via `@elevenlabs/react` (client realtime session: WebRTC/WebSocket, VAD, barge-in, STT→TTS, `clientTools`, `sendContextualUpdate`, `onMessage`, `onAgentResponseCorrection`) + ElevenLabs REST (`/v1/convai/conversation/token`, server-side mint — **reuses 005's `lib/live-tutor/token.ts`**) · **native Claude** as the agent LLM (configured on the agent, no custom proxy) · existing `@idiomatic/contracts` (Zod) · the **plan derivation reads the persisted `LessonScript`** (the generator's boundary artifact; generation behavior unchanged) · Supabase JS (Postgres + RLS) · Auth0 (`@auth0/nextjs-auth0`) · the in-repo structured logger (`@idiomatic/generator` observability port). Reuses the pinned ElevenLabs teacher voice from 002. (006-adaptive-live-story)
- Supabase Postgres — two new owner-scoped tables `live_sessions` and `session_turns` (the durable transcript), RLS keyed on the Auth0 subject like `lessons`. No new Storage bucket. **Realtime audio is NOT persisted** (FR-025); the text transcript is the only durable record. 005's `qa_exchanges`/`qa_turns` are left in place (that mode still backs the fallback) and are not reused — they are exchange/position-scoped and do not fit a continuous session. (006-adaptive-live-story)
- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · `@idiomatic/contracts` (Zod) · Supabase JS (Postgres + Storage) · Auth0 · in-repo structured logger. **Removed from the generation path**: `@elevenlabs/elevenlabs-js` (server Text-to-Dialogue). **Untouched / still required**: `@elevenlabs/react` + ElevenLabs Conversational AI (live-story realtime), native Claude (generation brain + agent LLM). (007-live-only)
- Supabase Postgres + Storage. Forward-only change drops the `lesson-audio` Storage bucket, the `lesson_audio` table, the `audio_duration_seconds` column on `lessons`, and the `qa_exchanges`/`qa_turns` tables (+ `qa_turn_role` enum). `live_sessions`/`session_turns` retained unchanged (FR-008). No auth/RLS redesign (FR-015). (007-live-only)

- TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · Mastra (generation workflow) · `@anthropic` Claude (generation brain) · ElevenLabs `@elevenlabs/elevenlabs-js` (server, Text to Dialogue / Eleven v3) + `@elevenlabs/react` (client playback) · Supabase JS (`@supabase/supabase-js`, Postgres + Storage) · Auth0 (`@auth0/nextjs-auth0`) · Zod (shared schemas) · LangSmith via `@mastra/langsmith` (eval/observability) (002-lesson-generation)

## Project Structure

```text
packages/contracts/   # shared Zod schemas + DTOs (subsystem boundary)
packages/generator/   # lesson generation: adapters, prompts, workflow, evals
packages/live-story/  # adaptive live-story subsystem: prompt, narration state machine, client tools, services
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
- 007-live-only: Added TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · `@idiomatic/contracts` (Zod) · Supabase JS (Postgres + Storage) · Auth0 · in-repo structured logger. **Removed from the generation path**: `@elevenlabs/elevenlabs-js` (server Text-to-Dialogue). **Untouched / still required**: `@elevenlabs/react` + ElevenLabs Conversational AI (live-story realtime), native Claude (generation brain + agent LLM).
- 006-adaptive-live-story: Added TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · **ElevenLabs Agents / Conversational AI** via `@elevenlabs/react` (client realtime session: WebRTC/WebSocket, VAD, barge-in, STT→TTS, `clientTools`, `sendContextualUpdate`, `onMessage`, `onAgentResponseCorrection`) + ElevenLabs REST (`/v1/convai/conversation/token`, server-side mint — **reuses 005's `lib/live-tutor/token.ts`**) · **native Claude** as the agent LLM (configured on the agent, no custom proxy) · existing `@idiomatic/contracts` (Zod) · the **plan derivation reads the persisted `LessonScript`** (the generator's boundary artifact; generation behavior unchanged) · Supabase JS (Postgres + RLS) · Auth0 (`@auth0/nextjs-auth0`) · the in-repo structured logger (`@idiomatic/generator` observability port). Reuses the pinned ElevenLabs teacher voice from 002.
- 005-live-tutor-qa: Added TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II) + Next.js (App Router) · **ElevenLabs Agents / Conversational AI** via `@elevenlabs/react` (client realtime session: WebRTC/WebSocket, VAD, barge-in, STT→TTS) + ElevenLabs REST (`/v1/convai/conversation/token`, server-side token mint) · **native Claude** as the agent LLM (configured in the agent, no custom proxy) · existing `@idiomatic/contracts` (Zod) · Supabase JS (Postgres + RLS) · Auth0 (`@auth0/nextjs-auth0`) · the existing in-repo structured logger (`@idiomatic/generator` observability port). Reuses the existing pinned ElevenLabs teacher voice from 002.


<!-- MANUAL ADDITIONS START -->

## Generation architecture note

Generation is implemented as a plain `generateLesson` orchestrator
(`packages/generator/src/index.ts`), not a Mastra runtime. As of 007-live-only it is
**script-only**: `generateLesson` returns `{ script, metadata }` (ordered items, story beats,
two personas, coverage, bounded target length) and a lesson is **ready** on a valid script —
no audio is synthesized, stitched, or stored. LangSmith traceability is wired directly via the
`langsmith` SDK in `packages/generator/src/workflow/tracing.ts` (`generateLessonTraced`), used
by the web app's generation runner. The `@mastra/langsmith` exporter from plan.md was
superseded because there is no Mastra trace stream to export. LangSmith is a soft dependency —
everything degrades to a no-op without `LANGSMITH_API_KEY`.

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

## Adaptive live story note (006-adaptive-live-story)

A second realtime mode (alongside 005's live Q&A) narrates a ready lesson **live** in the
pinned teacher voice — no `<audio>` element. ElevenLabs Agents owns turn-taking / barge-in /
VAD / STT / streaming TTS (Principle IV); the app builds only glue:

- **Plan derivation** is a PURE, read-only helper `derivePlan(script, items, config)` in
  `packages/generator/src/workflow/derive-plan.ts` — it maps the persisted `LessonScript` +
  `source_items` to a `LessonPlan` (ordered items, story beats, clamped target length). It
  does **not** touch batch generation or its eval gate. Coverage entries are mapped to
  persisted item ids by `normalizedText` (same as `live-tutor/current-item.ts`).
  The whole subsystem now lives in its own package **`@idiomatic/live-story`**
  (`packages/live-story/src/`); the web app wires its `LessonRepository` into the package's
  narrow read-only `LessonReader` port, and `lib/config.ts` is the env reader that produces
  the package's `LiveStoryConfig`. The package depends only on `@idiomatic/contracts` +
  `@idiomatic/generator` (no Next/Supabase/DOM).
- **Narration state machine** `packages/live-story/src/narration/narration-state.ts` is PURE
  (no SDK/DOM): covered-set + completion guard (conclude only when every item is covered AND
  the beat budget is spent — coverage always wins), scenario pin (latest wins), clarification
  guard (ported from 005's `exchange-state.ts`), and the caption reducer (append +
  `correctLastTeacherCaption`). Unit-tested in `tests/unit/narration-state.test.ts`.
- **Client tools** (`advanceNarration`, `markItemTaught`, `setScenario`, `concludeLesson`) in
  `packages/live-story/src/agent/client-tools.ts` are thin glue over the state machine, returning
  short instruction strings the agent continues from (the agent-driven self-continuation loop, R1).
- **Agent prompt** is a VERSIONED source artifact (`packages/live-story/src/agent/agent-prompt.ts`,
  Constitution III) — pasted onto the dedicated `ELEVENLABS_STORY_AGENT_ID` agent.
- **Captions + transcript share one corrected-text path**: the hook
  (`app/lessons/[id]/live-story/useLiveStory.ts`) consumes `onMessage` (finalized turns) and
  `onAgentResponseCorrection` (barge-in truncation), never the tentative stream (R5). Turns
  persist incrementally and best-effort, OFF the speech path, via
  `POST /api/lessons/{id}/live-story/turns` → the package's `transcript-service.ts` →
  `lib/supabase/live-story-repository.ts` (impl of the package's `LiveStoryRepository` port) →
  `live_sessions`/`session_turns` (migration `0005_live_story.sql`, owner-scoped RLS). A
  teacher turn carrying a known `elevenTurnRef` is upserted in place (the only mutation).
  **No realtime audio is ever persisted** (FR-025).
- **Observability**: `story.*` `EventId`s in `observability/events.ts`
  (`story.session|beat|coverage|scenario|turn|error|unavailable`).
- **Feature gate**: `lib/config.ts` `liveStoryConfig()` + `StartStoryService.available()` (the
  agent id + key must both be configured server-side);
  when unconfigured or a mint/transport drop occurs, the UI shows a clear retry/try-later
  panel — modes stay decoupled, no pre-render substitution (R7). The token mint
  (`packages/live-story/src/services/token.ts`, moved from 005's `lib/live-tutor/token.ts`) lives in the
  package alongside the service that uses it.

When adding to this subsystem, keep the narration logic pure and in `narration-state.ts`,
add client tools over it, and never put realtime/audio handling in app code (buy it from the
platform). Verify with `pnpm test && pnpm typecheck && pnpm lint`.

## Live-only note (007-live-only)

The product is **live-only**: the adaptive live-narrated story (006) is the single learner
experience and the live-session transcript (`live_sessions`/`session_turns`) is the single
durable record. Feature 007 retired, via a forward-only change:

- **Pre-rendered audio**: the server Text-to-Dialogue render adapter
  (`packages/generator/src/adapters/elevenlabs.ts`), the `TtsAdapter`/`RenderedAudio` port +
  mocks, the `tts*` generator config, the `render.*` log events, the `AudioStorage` port +
  Supabase impl, the audio-serving route, and the `scoreLength` eval scorer. `generateLesson`
  no longer renders; the web bridge marks `ready` on a valid script with **no** storage upload.
- **005 playback-position Q&A**: the `lib/qa/` + `lib/live-tutor/` (minus **`token.ts`**,
  reused by live-story), the `live-tutor/` UI, the `/live-session` + `/exchanges` routes, the
  `qa.*` log events, and the `qa.ts` contract. The token mint (005's `lib/live-tutor/token.ts`)
  was retained for live-story and has since moved into `@idiomatic/live-story`
  (`packages/live-story/src/services/token.ts`); `lib/live-tutor/` is now gone.
- **Data**: migration `0006_retire_audio_qa.sql` drops the `lesson-audio` bucket (+ RLS), the
  `lesson_audio` table, `lessons.audio_duration_seconds`, and `qa_exchanges`/`qa_turns`
  (+ `qa_turn_role`). `live_sessions`/`session_turns`/`source_items` are untouched.

No audio is ever pre-rendered or stored. The eval gate (`pnpm eval:generation`) is script-only
(coverage · two-persona · story-not-definition). The constitution is at **v2.0.0** (the
scripted-podcast stack component was dropped). When touching generation, keep it script-only;
never reintroduce a server render path.

<!-- MANUAL ADDITIONS END -->
