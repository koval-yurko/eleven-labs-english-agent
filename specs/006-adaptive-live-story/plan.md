# Implementation Plan: Adaptive, Interruptible Live-Narrated Lesson

**Branch**: `006-adaptive-live-story` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-adaptive-live-story/spec.md`

## Summary

Replace fixed-file playback with a **single live realtime session** that narrates a lesson aloud in the pinned teacher voice, driven by a **lesson plan** (ordered teachable items + story beats + bounded target length) derived from the existing generation output. In that same session the learner can, hands-free, **barge in to ask a question** or **steer the story scenario** ("make this about space travel"); the narration adapts, keeps the new scenario in effect, and still teaches every planned item at least once before a natural ending. Throughout, the learner sees **subtitle-level captions** of both voices, finalized turn by turn, with the teacher caption **corrected** to what was actually spoken on barge-in. The full session — narration + Q&A, corrected text — is captured as a **durable text transcript** associated with the lesson and reviewable later; the transcript, not the audio, is the replayable record. When the live capability is unavailable, the learner gets a clear message and a sensible fallback.

Technical approach: this is the constitution's **Interactive Player + Live Tutor** (realtime) subsystem, extended from 005. The hard realtime parts (STT, turn-taking, **barge-in**, streaming TTS, VAD) remain **owned by ElevenLabs Agents** (Principle IV) — never reimplemented. The new glue is **continuous narration on a turn-based agent**: the agent narrates one beat at a time and calls **client tools** (`advanceNarration`, `markItemTaught`, `setScenario`, `concludeLesson`) whose return values drive a framework-free **narration state machine** that tracks covered items, pins the scenario, enforces the length budget, and guarantees every planned item is taught before the agent concludes. The **lesson plan is derived read-only** from the persisted `LessonScript` + `source_items` at session start (no change to the batch generator, no new generation flow — preserving subsystem independence and the generation eval gate). Captions come from `onMessage` (finalized turns) + `onAgentResponseCorrection` (barge-in truncation). The transcript persists **incrementally** to two new owner-scoped Supabase tables (`live_sessions`, `session_turns`) so an abandoned session keeps its partial record. The Next.js app mints an owner-scoped conversation token server-side (the `xi-api-key` never reaches the browser). There is no `<audio>` element; 005's playback-position/current-item seam is retired for this mode. When live is unavailable, the live-story UI shows a **clear message + retry / try-later** (the modes stay decoupled — no pre-render substitution; research R7, confirmed with the user).

## Technical Context

**Language/Version**: TypeScript (strict) on Node 20 LTS — single language end-to-end (Constitution II)
**Primary Dependencies**: Next.js (App Router) · **ElevenLabs Agents / Conversational AI** via `@elevenlabs/react` (client realtime session: WebRTC/WebSocket, VAD, barge-in, STT→TTS, `clientTools`, `sendContextualUpdate`, `onMessage`, `onAgentResponseCorrection`) + ElevenLabs REST (`/v1/convai/conversation/token`, server-side mint — **reuses 005's `lib/live-tutor/token.ts`**) · **native Claude** as the agent LLM (configured on the agent, no custom proxy) · existing `@idiomatic/contracts` (Zod) · the **plan derivation reads the persisted `LessonScript`** (the generator's boundary artifact; generation behavior unchanged) · Supabase JS (Postgres + RLS) · Auth0 (`@auth0/nextjs-auth0`) · the in-repo structured logger (`@idiomatic/generator` observability port). Reuses the pinned ElevenLabs teacher voice from 002.
**Storage**: Supabase Postgres — two new owner-scoped tables `live_sessions` and `session_turns` (the durable transcript), RLS keyed on the Auth0 subject like `lessons`. No new Storage bucket. **Realtime audio is NOT persisted** (FR-025); the text transcript is the only durable record. 005's `qa_exchanges`/`qa_turns` are left in place but **not reused** here — they are exchange/position-scoped and do not fit a continuous session.
**Testing**: Vitest (unit + contract + integration) with the realtime session, client tools, and token mint **mocked/faked** (no live keys in CI, Constitution Dev Workflow) — the **narration state machine and plan derivation are pure and unit-tested without the SDK or a DOM** · Playwright E2E for narrate → barge-in question → resume, scenario-steer → coverage-still-complete, and barge-in-caption-correction, with a fake conversation transport · contract tests on the new `LessonPlan`/`LiveSession`/`SessionTurn` schemas, the client-tool return contracts, and the HTTP routes.
**Target Platform**: Responsive web — modern desktop + mobile browsers with microphone access (getUserMedia). No native apps (FR-029).
**Performance Goals**: Barge-in stop within ~0.5s of detected speech (SC-005, platform VAD). Time-to-first-audio for a live answer < ~1.5s (Constitution I): native Claude Haiku, streaming cascade, and **never blocking narration or answers on persistence** (transcript writes are async/best-effort). A relevant spoken answer begins within a few seconds (SC-006).
**Constraints**: Barge-in / turn-taking / STT / TTS / VAD MUST come from ElevenLabs Agents, not custom code (Principle IV) — including the continuous-narration loop, which is built only from platform **client tools**, not a reimplemented audio path. Teacher voice MUST be the same pinned voice as the scripted podcast (Constitution I); the agent is provisioned with that voice id. Cascaded STT→LLM→TTS is mandatory (the transcript must stay available; speech-to-speech out of scope). Provider secrets stay server-side; the browser only ever sees a short-lived conversation token (Principle V). **Coverage and length guarantees move from generation time to narration time** — enforced live by the narration state machine + the agent, and observable in the transcript/logs.
**Scale/Scope**: Single self-directed learner per account; one live session at a time per learner; one narration of a handful of items with a few interruptions per session; personal-scale transcript volume. No multi-user/social.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Voice-First Experience Quality | Live narration **and** answers use the **same pinned teacher voice id** (agent provisioned with it; reused from 002). Barge-in stays responsive via platform VAD (≤ ~0.5s, SC-005); answer time-to-first-audio < ~1.5s via native Claude Haiku + streaming cascade + no persistence on the speech path. Expressiveness is the agent's natural narration (a told story, not a list). Latency surfaces are measured (SC-005/006) and regressions must be justified. | ✅ PASS |
| II. One Language, End-to-End | All new code is TypeScript/Node; no Python/second runtime. New shared shapes (`LessonPlan`, `PlanBeat`, `LiveSession`, `SessionTurn`, `StartStoryToken`, `AppendTurnRequest`, client-tool I/O) are explicit Zod schemas in `packages/contracts`; no `any` across module boundaries. | ✅ PASS |
| III. Evaluated, Reproducible Generation | This feature does **not** modify batch lesson generation — the lesson plan is **derived read-only** from the persisted `LessonScript` + `source_items`, so the generation eval gate cannot regress. The narrator/tutor/steering **agent prompt and the plan-derivation are versioned artifacts in source control** (no untracked prompt strings). Each session persists the ElevenLabs `conversationId`, the lesson + plan it narrated, the scenario(s) in effect, and the model used, so a session is reproducible/debuggable. Coverage/length, formerly validated at generation time, are now **enforced and observed at narration time** (state machine + `story.*` log events). | ✅ PASS |
| IV. Buy the Hard Parts, Build the Glue | ElevenLabs Agents owns turn-taking, **barge-in**, VAD, STT, and streaming TTS; Claude is the agent LLM **natively**. Continuous narration is built from platform **client tools** + `sendContextualUpdate`, not a custom realtime/audio path. We build only glue: plan derivation, token mint (reused), the narration state machine (advance/coverage/scenario/conclude), caption rendering, and transcript persistence. | ✅ PASS |
| V. Learner Data Integrity & Privacy | The transcript is owned by exactly one learner; new tables use Postgres RLS keyed on the Auth0 subject (same pattern as `lessons`/`qa_*`). Every turn stays **anchored to the lesson + the session + (where applicable) the item being taught** (no lost anchor). ElevenLabs/Anthropic secrets stay server-side; the browser receives only a short-lived conversation token. Raw transcript text is learner content (private; logged only at `debug`, per 003). **No realtime audio is persisted** (FR-025). | ✅ PASS |
| Subsystem independence | The live story (realtime) **reads** the persisted `LessonScript` + `source_items` (the agreed boundary artifact) to derive the plan and ground the narration; it shares **no internal state** with the batch generator and adds its own tables. `packages/generator` is touched only to add a read-only `derivePlan` helper next to its other pure workflow utilities and to register `story.*` `EventId`s — its generation behavior is unchanged. Each subsystem stays independently buildable/testable. | ✅ PASS |

**Result**: All gates pass. No deviations → Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/006-adaptive-live-story/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (decisions + rationale)
├── data-model.md        # Phase 1 output (LessonPlan derived; live_sessions/session_turns + RLS)
├── quickstart.md        # Phase 1 output (provision narrator agent + client tools, env, run, verify)
├── contracts/           # Phase 1 output
│   ├── live-story.schema.json    # LessonPlan / LiveSession / SessionTurn / StartStoryToken + client-tool I/O
│   └── http-api.md               # live-story token + transcript persistence/review routes
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

Additive to the existing pnpm workspace; new files marked **(new)**, touched files marked **(edit)**.

```text
packages/contracts/
└── src/
    ├── live-story.ts                 # (new) LessonPlan, PlanBeat, LiveSession, SessionTurn,
    │                                 #       SessionTurnRole/Kind, StartStoryToken,
    │                                 #       AppendTurnRequest, TranscriptDTO + client-tool I/O Zod
    └── index.ts                      # (edit) export the new schemas

packages/generator/
└── src/
    ├── workflow/derive-plan.ts       # (new) PURE, read-only: LessonScript + items -> LessonPlan
    │                                 #       (ordered teachable items, story beats, target length)
    ├── index.ts                      # (edit) export derive-plan
    └── observability/events.ts       # (edit) add story.* EventIds: story.session, story.beat,
                                      #        story.coverage, story.scenario, story.turn,
                                      #        story.error, story.unavailable

apps/web/
├── app/
│   ├── api/lessons/[id]/
│   │   ├── live-story/route.ts        # (new) POST → derive plan, mint owner-scoped token,
│   │   │                              #       open a LiveSession; 409 not-ready, 503 fallback
│   │   ├── live-story/turns/route.ts  # (new) POST append finalized turn(s) to the session
│   │   │                              #       (incremental; off the speech path; FR-027)
│   │   └── transcript/route.ts        # (new) GET review the durable transcript (later sessions)
│   └── lessons/[id]/
│       ├── page.tsx                   # (edit) offer Live Story for a ready lesson; render
│       │                              #        transcript review; retry/try-later fallback panel
│       └── live-story/                # (new) client components
│           ├── LiveStoryProvider.tsx  #        @elevenlabs/react ConversationProvider wrapper
│           ├── LiveStoryController.tsx#        orchestration: start, client tools, captions,
│           │                          #        scenario, persistence, fallback (no <audio>)
│           ├── CaptionLog.tsx         #        subtitle captions (turn-by-turn, attributed)
│           └── useLiveStory.ts        #        hook binding SDK callbacks ↔ narration state machine
├── lib/
│   ├── live-story/
│   │   ├── plan-context.ts            # (new) LessonPlan -> dynamic variables + scenario-pin text
│   │   ├── agent-prompt.ts            # (new) VERSIONED narrator/tutor/steering system prompt +
│   │   │                              #       client-tool descriptions (Constitution III)
│   │   ├── narration-state.ts         # (new) PURE state machine: covered-set, current beat,
│   │   │                              #       scenario, length budget, completion guard, captions
│   │   ├── client-tools.ts            # (new) build the clientTools map from narration-state
│   │   │                              #       (advanceNarration, markItemTaught, setScenario, conclude)
│   │   ├── availability.ts            # (new) is-live-story-configured check (mirrors 005)
│   │   ├── service.ts                 # (new) StartStoryService: derive plan + mint token +
│   │   │                              #       open session; degrade to "unavailable" (FR-026)
│   │   ├── transcript-service.ts      # (new) append turns / list transcript (validation, RLS)
│   │   ├── repository.ts              # (new) LiveStoryRepository interface (owner-scoped)
│   │   └── in-memory-repository.ts    # (new) test impl
│   ├── live-tutor/token.ts            # (reuse) mintConversationToken — shared, unchanged
│   ├── container.ts                   # (edit) wire StartStoryService + transcript service + repo
│   └── supabase/live-story-repository.ts # (new) RLS-scoped Supabase impl
└── tests/
    ├── unit/
    │   ├── derive-plan.test.ts        # (new) plan derivation from a LessonScript fixture
    │   └── narration-state.test.ts    # (new) coverage guarantee, scenario pin, length budget,
    │                                  #       barge-in caption correction, clarification escape
    ├── contract/live-story-api.test.ts# (new) live-story + turns + transcript route contracts
    ├── integration/
    │   ├── live-story-session.test.ts # (new) plan derivation, token mint, ownership, 409/503 fallback
    │   └── live-story-transcript.test.ts # (new) incremental persist, corrected text, ordering, privacy
    └── e2e/live-story-flow.spec.ts    # (new) narrate→barge-in→resume, steer→coverage, caption-correction

supabase/migrations/
└── 0005_live_story.sql               # (new) live_sessions + session_turns tables, indexes, RLS
```

**Structure Decision**: Extend the existing pnpm workspace (no new project). The live story is the constitution's realtime subsystem; it reuses `packages/contracts` for the new plan/transcript shapes and **reads** the persisted `LessonScript` + `source_items` (the agreed subsystem boundary) to derive the plan and ground narration. `packages/generator` gains one **pure, read-only** `derivePlan` helper (alongside `validate-coverage`) and new logging `EventId`s; its generation behavior is unchanged, preserving subsystem independence and the generation eval gate. All realtime/UI/persistence glue lives in `apps/web`, mirroring 002/005's repository + service + container DI and in-memory-vs-Supabase test seam so the suite runs without live keys. 005's live-tutor code (`<audio>`-position Q&A) is left intact but independent; the new mode is a parallel, additive slice with its own retry/try-later fallback (research R7).

## Complexity Tracking

> No Constitution Check violations. Section intentionally empty.
