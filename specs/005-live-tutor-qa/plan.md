# Implementation Plan: Live, Interruptible Q&A During a Podcast Lesson

**Branch**: `005-live-tutor-qa` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-live-tutor-qa/spec.md`

## Summary

While a generated podcast lesson is playing, the learner can interrupt at any moment **just by speaking** (hands-free) to ask a spoken follow-up; the lesson pauses, a live spoken answer comes back **in the same pinned teacher voice**, the learner can barge in over that answer for a multi-turn exchange, and when the exchange ends the lesson resumes **from the exact interruption point**. Every exchange is captured as a text transcript tied to the lesson and the item that was active at interruption. Empty/unintelligible input is met with a clarification prompt, off-topic questions get a brief answer or redirect, and live-tutor unavailability degrades to a clear message + "continue the lesson, try later" fallback.

Technical approach: this is the **Interactive Player + Live Tutor** subsystem from the constitution, built as an additive slice on top of the existing batch **Lesson Generator** (002) — the two communicate only through the persisted `LessonScript` (Constitution: subsystem independence). The genuinely hard realtime parts (STT, turn-taking, **barge-in**, TTS streaming) are **owned by ElevenLabs Agents** (Conversational AI), never reimplemented (Principle IV). We provision a single **live-tutor Agent** configured with the **pinned teacher voice** and a **native Claude LLM** (Haiku 4.5 for latency — cascaded STT→LLM→TTS, so the transcript stays available, per the constitution's mandatory cascade). The Next.js app mints an owner-scoped **conversation token** server-side (the `xi-api-key` never reaches the browser), the browser drives the realtime session with **`@elevenlabs/react`**, lesson context (lesson summary + current item) is injected per session via **dynamic variables** and `sendContextualUpdate`, and play/pause/resume + "which item is active" + transcript persistence are the **glue** we build. Pause/resume is purely client-side on the lesson `<audio>`; transcripts persist to new owner-scoped Supabase tables (`qa_exchanges`, `qa_turns`) with the same RLS pattern as lessons.

## Technical Context

**Language/Version**: TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II)
**Primary Dependencies**: Next.js (App Router) · **ElevenLabs Agents / Conversational AI** via `@elevenlabs/react` (client realtime session: WebRTC/WebSocket, VAD, barge-in, STT→TTS) + ElevenLabs REST (`/v1/convai/conversation/token`, server-side token mint) · **native Claude** as the agent LLM (configured in the agent, no custom proxy) · existing `@idiomatic/contracts` (Zod) · Supabase JS (Postgres + RLS) · Auth0 (`@auth0/nextjs-auth0`) · the existing in-repo structured logger (`@idiomatic/generator` observability port). Reuses the existing pinned ElevenLabs teacher voice from 002.
**Storage**: Supabase Postgres — two new owner-scoped tables `qa_exchanges` and `qa_turns` (transcript record), RLS keyed on the Auth0 subject like `lessons`. No new Storage bucket. Live answer **audio is not persisted** in v1 (the text transcript is the durable record); the realtime audio is ephemeral session output.
**Testing**: Vitest (unit + contract + integration) with the ElevenLabs realtime session and token mint **mocked/faked** (no live keys in CI, Constitution Dev Workflow) · Playwright E2E for the interrupt → answer → barge-in → resume → resume-point flow on desktop + mobile, with a fake conversation transport · contract tests on the new `QaExchange`/`QaTurn` schemas and the HTTP routes.
**Target Platform**: Responsive web — modern desktop + mobile browsers with microphone access (getUserMedia). No native apps (NG1).
**Project Type**: Web application — additive to the existing pnpm workspace (`packages/contracts`, `apps/web`). No change to `packages/generator`'s generation behavior.
**Performance Goals**: **Time-to-first-audio for a live answer SHOULD be < ~1.5s** (Constitution I). Achieved by: native Claude **Haiku** with reasoning off, ElevenLabs streaming cascade, and **never blocking the answer path on persistence** (transcripts are written after/asynchronously). Lesson pause on detected speech and barge-in stop both target ≤ ~0.5s (SC-001/SC-005), handled by platform VAD.
**Constraints**: Barge-in / turn-taking / STT / TTS MUST come from ElevenLabs Agents, not custom code (Principle IV). Teacher voice MUST be the same pinned voice as the scripted podcast (Constitution I) — the agent is provisioned with that voice id, so no per-session voice override is required. Cascaded STT→LLM→TTS is mandatory (transcript must stay available; speech-to-speech is out of scope). Provider secrets stay server-side; the browser only ever sees a short-lived conversation token (Principle V). The agent stays connected for the listening window of a play session, which consumes Conversational-AI minutes (accepted v1 tradeoff, see research R7).
**Scale/Scope**: Single self-directed learner per account; one live session at a time per learner; a handful of exchanges per lesson; personal-scale transcript volume. No multi-user/social (NG3).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Voice-First Experience Quality | Live answers use the **same pinned teacher voice id** (agent provisioned with it). Barge-in stays responsive via platform VAD; **time-to-first-audio < ~1.5s** via native Claude Haiku + streaming cascade + no persistence in the answer path. Latency surfaces are measured (SC-001/002/005) and any regression must be justified. | ✅ PASS |
| II. One Language, End-to-End | All new code is TypeScript/Node; no Python/second runtime. New shared shapes (`QaExchange`, `QaTurn`, live-session token DTO) are explicit Zod schemas in `packages/contracts`; no `any` across module boundaries. | ✅ PASS |
| III. Evaluated, Reproducible Generation | This feature does **not** modify batch lesson generation, so it cannot regress the generation eval gate. The live-tutor **agent system-prompt/context template is a versioned artifact in source control** (no untracked prompt strings). Each exchange persists the ElevenLabs `conversationId`, the lesson/item it was grounded in, and the model used, so a live answer is reproducible/debuggable. | ✅ PASS |
| IV. Buy the Hard Parts, Build the Glue | ElevenLabs Agents owns turn-taking, **barge-in**, STT, and TTS streaming; Claude is the agent LLM **natively** (no custom realtime infra, no LLM proxy). We build only glue: token mint, context injection, client-side pause/resume, current-item resolution, transcript persistence. | ✅ PASS |
| V. Learner Data Integrity & Privacy | Transcripts are owned by exactly one learner; new tables use Postgres RLS keyed on the Auth0 subject (same pattern as `lessons`). Each turn stays **anchored to the lesson + the relevant item** (no lost anchor = no data-loss defect). ElevenLabs/Anthropic secrets stay server-side; the browser receives only a short-lived conversation token. Raw transcript text is treated as learner content (private; logged only at `debug`, like draft bodies in 003). | ✅ PASS |
| Subsystem independence | Live Tutor (realtime) reads the persisted `LessonScript` + source items to ground answers and locate the current item; it shares **no internal state** with the batch generator and adds its own tables. Each subsystem stays independently buildable/testable. | ✅ PASS |

**Result**: All gates pass. No deviations → Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/005-live-tutor-qa/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (decisions + rationale)
├── data-model.md        # Phase 1 output (entities, tables, RLS, current-item resolution)
├── quickstart.md        # Phase 1 output (provision agent, env, run, verify)
├── contracts/           # Phase 1 output
│   ├── qa.schema.json            # QaExchange / QaTurn boundary schema
│   └── http-api.md               # live-session token + exchange persistence routes
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

Additive to the existing workspace; new files marked **(new)**, touched files marked **(edit)**.

```text
packages/contracts/
└── src/
    ├── qa.ts                         # (new) QaExchange, QaTurn, QaTurnRole, LiveSessionToken DTOs + Zod
    └── index.ts                      # (edit) export the new schemas

packages/generator/
└── src/observability/
    └── events.ts                     # (edit) add live-tutor EventIds: qa.session, qa.turn,
                                      #        qa.exchange, qa.error, qa.unavailable

apps/web/
├── app/
│   ├── api/lessons/[id]/
│   │   ├── live-session/route.ts     # (new) POST → owner-scoped ElevenLabs conversation token + agent context
│   │   └── exchanges/route.ts        # (new) POST persist an exchange + turns; GET list a lesson's exchanges
│   └── lessons/[id]/
│       ├── page.tsx                  # (edit) mount the live-tutor player when lesson is ready
│       └── live-tutor/               # (new) client components
│           ├── LiveTutorProvider.tsx #        @elevenlabs/react ConversationProvider wrapper
│           ├── LiveTutorController.tsx#        orchestration: mic, pause/resume, capture, fallback
│           └── usePlaybackQa.ts      #        hook: lesson <audio> pause/resume + interruption point
├── lib/
│   ├── live-tutor/
│   │   ├── token.ts                  # (new) server: mint conversation token (xi-api-key server-only)
│   │   ├── context.ts                # (new) build dynamic variables + grounding context from LessonScript
│   │   ├── agent-prompt.ts           # (new) VERSIONED system-prompt/context template (Constitution III)
│   │   ├── current-item.ts           # (new) resolve active source item from playback position (R3)
│   │   └── availability.ts           # (new) is-live-tutor-configured + reachable check (FR-017)
│   └── qa/
│       ├── repository.ts             # (new) QaRepository interface (owner-scoped)
│       ├── in-memory-repository.ts   # (new) test impl
│       └── service.ts                # (new) persist/list exchanges; validation
│   └── container.ts                  # (edit) wire QaRepository (Supabase | in-memory) + service
│   └── supabase/qa-repository.ts     # (new) RLS-scoped Supabase impl
└── tests/
    ├── contract/qa-api.test.ts       # (new) live-session + exchanges route contracts
    ├── integration/
    │   ├── live-tutor-session.test.ts# (new) token mint, ownership, availability fallback (faked transport)
    │   └── qa-transcript.test.ts     # (new) exchange/turn persistence, item association, privacy logging
    └── e2e/live-tutor-flow.spec.ts   # (new) interrupt→answer→barge-in→resume-at-point (faked transport)

supabase/migrations/
└── 0004_qa.sql                       # (new) qa_exchanges + qa_turns tables, indexes, RLS policies
```

**Structure Decision**: Extend the existing pnpm workspace rather than add a project. The live tutor is the constitution's realtime subsystem; it reuses `packages/contracts` for the new transcript shapes and reads the persisted `LessonScript` (the agreed subsystem boundary) to ground answers and locate the current item. `packages/generator` is touched **only** to register new logging `EventId`s (the logger is the shared observability port from 003); its generation behavior is unchanged, preserving subsystem independence and the generation eval gate. All realtime/UI/persistence glue lives in `apps/web`, mirroring 002's repository + service + container DI and in-memory-vs-Supabase test seam so the suite runs without live keys.

## Complexity Tracking

> No Constitution Check violations. Section intentionally empty.
