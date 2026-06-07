---
description: "Task list for 005-live-tutor-qa implementation"
---

# Tasks: Live, Interruptible Q&A During a Podcast Lesson

**Input**: Design documents from `/specs/005-live-tutor-qa/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: INCLUDED. The constitution's Development Workflow mandates contract tests on subsystem boundaries and integration tests against mocks (no live keys in CI), and plan.md's Testing section requires contract + integration + Playwright E2E. Test tasks are therefore part of each story.

**Organization**: Tasks are grouped by user story (US1–US4) so each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1, US2, US3, US4 (Setup/Foundational/Polish have no story label)

## Path Conventions

pnpm workspace: shared schemas in `packages/contracts/`, observability port in `packages/generator/`, realtime/UI/persistence glue + tests in `apps/web/`, SQL in `supabase/migrations/`. The batch generator's generation behavior is NOT modified.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Pull in the managed realtime SDK and declare config.

- [X] T001 Add the `@elevenlabs/react` client SDK to the web app: `pnpm --filter @idiomatic/web add @elevenlabs/react`
- [X] T002 [P] Add `ELEVENLABS_AGENT_ID` (and a comment that `ELEVENLABS_API_KEY` / `ELEVENLABS_TEACHER_VOICE_ID` are reused, and that live Q&A is feature-gated on these) to `apps/web/.env.example` and the root `.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared contracts, logging events, and the DB schema that every story builds on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 [P] Create the Q&A boundary schemas in `packages/contracts/src/qa.ts`: Zod `QaTurnRole` (`learner`|`tutor`), `QaTurn`, `QaExchange`, `CreateExchangeRequest`, and `LiveSessionToken` (with inferred TS types), matching `specs/005-live-tutor-qa/contracts/qa.schema.json`
- [X] T004 Export the new schemas from `packages/contracts/src/index.ts` (depends on T003)
- [X] T005 [P] Add live-tutor `EventId`s to `packages/generator/src/observability/events.ts`: `qa.session`, `qa.turn`, `qa.exchange`, `qa.error`, `qa.unavailable` (logging port only; no generation behavior change)
- [X] T006 [P] Create migration `supabase/migrations/0004_qa.sql`: `qa_turn_role` enum, `qa_exchanges` + `qa_turns` tables, indexes, and owner-scoped RLS policies (select/insert keyed on `auth.jwt() ->> 'sub'`) per `data-model.md`
- [X] T007 [P] Contract test asserting the `packages/contracts` Zod schemas accept/reject per `contracts/qa.schema.json` (valid exchange/turn round-trips; empty turns, blank text, negative position rejected) in `apps/web/tests/contract/qa-schema.test.ts`

**Checkpoint**: Shared types, log events, and DB schema exist — story work can begin.

---

## Phase 3: User Story 1 - Interrupt to ask and resume from the exact point (Priority: P1) 🎯 MVP

**Goal**: While a ready lesson plays, the learner speaks → lesson pauses → a live spoken answer in the **teacher voice**, grounded in the current item → on exchange end the lesson resumes from the exact interruption point.

**Independent Test**: Play a ready lesson, speak a question mid-item; confirm the lesson pauses, an answer relevant to that item plays in the teacher voice, and the lesson resumes from the paused position. (Realtime transport faked in automated tests; real ElevenLabs agent in manual/E2E.)

### Tests for User Story 1 ⚠️

- [X] T008 [P] [US1] Contract test for `POST /api/lessons/{id}/live-session` (401 unauth, 404 not-owned, 409 not-ready, 503 unavailable, 200 returns `LiveSessionToken` with `dynamicVariables`) in `apps/web/tests/contract/qa-api.test.ts`
- [X] T009 [P] [US1] Integration test: token mint is owner-scoped and `xi-api-key` never returned to client; 409 when lesson not `ready`; 503 when agent not configured — using a faked ElevenLabs token client — in `apps/web/tests/integration/live-tutor-session.test.ts`
- [X] T010 [P] [US1] Unit test for the current-item resolver (char-proportional offsets over `LessonScript`; boundary/gap → most-recent item; pre-first → null) in `apps/web/tests/unit/current-item.test.ts`

### Implementation for User Story 1

- [X] T011 [P] [US1] Implement `apps/web/lib/live-tutor/availability.ts`: report live-tutor availability from `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` presence (FR-017, R8)
- [X] T012 [P] [US1] Implement `apps/web/lib/live-tutor/current-item.ts`: resolve the active `SourceItem` from `<audio>` position + `LessonScript` segments/coverage (R3)
- [X] T013 [US1] Create the versioned agent context template in `apps/web/lib/live-tutor/agent-prompt.ts`: base system prompt using dynamic variables `{{lesson_summary}}`, `{{items_list}}`, `{{current_item}}`, instructing brief, lesson-grounded answers (Constitution III — versioned, no untracked prompt strings)
- [X] T014 [US1] Implement `apps/web/lib/live-tutor/context.ts`: build `dynamicVariables` (lesson summary, items list, current item) from a `LessonScript` + source items (R4)
- [X] T015 [US1] Implement `apps/web/lib/live-tutor/token.ts`: server-side mint of an ElevenLabs conversation token for `ELEVENLABS_AGENT_ID` (xi-api-key server-only); returns token + connectionType (R1, Principle V)
- [X] T016 [US1] Implement `POST /api/lessons/[id]/live-session/route.ts`: auth + ownership (404 pattern), `ready` check (409), availability check (503 → fallback body), mint token (T015), build context (T014); emit `qa.session` / `qa.error` via the child logger bound to `{ lessonId, ownerId }` (depends on T011–T015)
- [X] T017 [P] [US1] Implement the playback hook `apps/web/app/lessons/[id]/live-tutor/usePlaybackQa.ts`: pause the lesson `<audio>` on detected speech and capture `currentTime` as the interruption point; resume from that point when the exchange ends; track a manual-pause flag so manual pause is NOT treated as a question (FR-002/FR-003/FR-004/FR-010)
- [X] T018 [US1] Implement `apps/web/app/lessons/[id]/live-tutor/LiveTutorProvider.tsx`: wrap `@elevenlabs/react` `ConversationProvider`; `startSession` with the conversation token + `dynamicVariables`; request mic; expose status/mode (R1, R5 — teacher voice comes from the agent config)
- [X] T019 [US1] Implement `apps/web/app/lessons/[id]/live-tutor/LiveTutorController.tsx`: orchestrate mic + `useConversationMode` → drive `usePlaybackQa` pause/resume; `sendContextualUpdate(current_item)` when the active item changes; `endSession()` on stop/navigate/lesson-end (R6/R7) (depends on T016–T018)
- [X] T020 [US1] Mount the live-tutor controller in `apps/web/app/lessons/[id]/page.tsx` only when the lesson is `ready`, alongside the existing player (depends on T019)

**Checkpoint**: A learner can interrupt by speaking, hear a teacher-voice answer grounded in the current item, and resume from the exact point. MVP is demoable.

---

## Phase 4: User Story 2 - Barge in over the answer (multi-turn) (Priority: P2)

**Goal**: The learner can speak over the tutor's answer; the answer stops (platform-native barge-in) and a new turn begins; after any number of turns the lesson still resumes from the **original** interruption point, and each new answer continues the exchange.

**Independent Test**: Ask a question, barge in mid-answer; confirm the answer stops fast, the new question is answered as a continuation, and on exchange end the lesson resumes from the original interruption point (not where the conversation drifted).

### Tests for User Story 2 ⚠️

- [X] T021 [P] [US2] Integration test: a multi-turn exchange (question → answer → barge-in → answer) keeps a single fixed interruption point and accumulates all turns in order; resume position equals the original — in `apps/web/tests/integration/live-tutor-bargein.test.ts`

### Implementation for User Story 2

- [X] T022 [US2] In `usePlaybackQa.ts`, fix the interruption point at the FIRST interruption of an exchange and do NOT overwrite it on subsequent barge-in turns (depends on T017)
- [X] T023 [US2] In `LiveTutorController.tsx`, accumulate an ordered in-memory turn buffer across barge-in turns within one exchange (opened at first interruption, closed at resume), so the exchange spans all turns (depends on T019)
- [X] T024 [US2] Verify/confirm the agent is configured as interruptible and the client does not suppress barge-in (do NOT call `sendUserActivity` during agent speech); document the agent interruption setting in `quickstart.md` if a config toggle is required (R1)

**Checkpoint**: Barge-in produces a natural multi-turn exchange that still resumes correctly.

---

## Phase 5: User Story 3 - Capture each exchange as a transcript tied to lesson + item (Priority: P3)

**Goal**: Every completed exchange is persisted as ordered text turns, anchored to the lesson and the relevant item, ordered among the lesson's exchanges, and listable.

**Independent Test**: Conduct an exchange on a specific item; confirm `GET /api/lessons/{id}/exchanges` returns the transcript anchored to that item, and that multiple exchanges are stored separately and ordered.

### Tests for User Story 3 ⚠️

- [X] T025 [P] [US3] Contract test for `POST /api/lessons/{id}/exchanges` (201 with stored `QaExchange`; 400 empty turns / blank text / negative position / `sourceItemId` not in lesson; 401; 404) and `GET .../exchanges` (ordered list) in `apps/web/tests/contract/qa-api.test.ts`
- [X] T026 [P] [US3] Integration test: persistence of exchange + turns, item association (the resolved `source_item_id`), append-only `exchange_index` ordering across multiple exchanges, and privacy (no raw turn text at `info` level) in `apps/web/tests/integration/qa-transcript.test.ts`

### Implementation for User Story 3

- [X] T027 [P] [US3] Define the owner-scoped `QaRepository` interface (createExchangeWithTurns, listExchanges) in `apps/web/lib/qa/repository.ts`
- [X] T028 [P] [US3] Implement `InMemoryQaRepository` (for tests) in `apps/web/lib/qa/in-memory-repository.ts`
- [X] T029 [US3] Implement `SupabaseQaRepository` (RLS-scoped client; denormalized `owner_id`) in `apps/web/lib/supabase/qa-repository.ts`
- [X] T030 [US3] Implement `QaService` in `apps/web/lib/qa/service.ts`: validate body, enforce `sourceItemId` belongs to the lesson, assign next `exchange_index`, stamp `owner_id`, persist via repo, list (depends on T027)
- [X] T031 [US3] Wire `QaRepository` (Supabase vs in-memory by `hasSupabaseEnv()`) + `QaService` into the composition root `apps/web/lib/container.ts` (depends on T027–T030)
- [X] T032 [US3] Implement `POST` and `GET /api/lessons/[id]/exchanges/route.ts` (auth, ownership, delegate to `QaService`); emit `qa.exchange` / `qa.turn` with raw text gated to `debug` (Constitution V) (depends on T031)
- [X] T033 [US3] In `LiveTutorController.tsx`, on exchange end: resolve the relevant item (T012), assemble `CreateExchangeRequest` from `onMessage` final turns + the fixed interruption point + `conversationId`, and POST it **after resume** (off the latency path) (depends on T019, T032)

**Checkpoint**: Exchanges are durably captured and reviewable, correctly anchored to lesson + item.

---

## Phase 6: User Story 4 - Graceful unclear / off-topic / unavailable handling (Priority: P3)

**Goal**: Empty/unintelligible input → clarify (with a guaranteed escape from the loop); off-topic → brief answer or redirect; live tutor unavailable → clear message + usable fallback, never a frozen lesson.

**Independent Test**: Trigger (a) silent/garbled input → clarify then escape after repeated failures; (b) off-topic question → brief/redirect; (c) agent unconfigured/unreachable → clear unavailable message with playback still working.

### Tests for User Story 4 ⚠️

- [X] T034 [P] [US4] Integration test: unavailable (503 / connect failure) surfaces the fallback message and the lesson stays playable; an empty/unintelligible turn does NOT create a persisted exchange — in `apps/web/tests/integration/live-tutor-fallback.test.ts`
- [X] T035 [P] [US4] Unit test: the clarification-loop guard counts consecutive clarification turns and trips the "return to lesson" escape at the threshold — in `apps/web/tests/unit/clarification-guard.test.ts`

### Implementation for User Story 4

- [X] T036 [US4] Augment `apps/web/lib/live-tutor/agent-prompt.ts`: instruct the tutor to ask the learner to repeat/clarify on empty/unintelligible input (FR-014) and to answer briefly or redirect off-topic questions back to the lesson (FR-016) (depends on T013)
- [X] T037 [US4] Implement the clarification-loop guard (count consecutive clarification turns; default threshold 3 → surface "Return to the lesson") in `apps/web/app/lessons/[id]/live-tutor/LiveTutorController.tsx` (FR-015) (depends on T019)
- [X] T038 [US4] Implement the unavailability fallback UI: render the 503/`onError`/connect-timeout state as a clear message and keep the lesson fully playable; ensure background/accidental speech with no intelligible turn produces no spurious persisted exchange (FR-017, edge cases) in the player / `LiveTutorController.tsx` (depends on T020, T033)

**Checkpoint**: All four stories are independently functional and robust.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T039 [P] Playwright E2E `apps/web/tests/e2e/live-tutor-flow.spec.ts`: full interrupt → answer → barge-in → resume-at-point flow on desktop + mobile viewports, with the realtime transport faked
- [X] T040 [P] Update `apps/web/README` / docs with the live-tutor setup pointer and the agent-provisioning note (link `quickstart.md`)
- [ ] T041 Manually validate acoustic-echo behavior (lesson audio ducked/paused within ~300ms of speech) and time-to-first-audio < ~1.5s against a real agent; record results (Constitution I, R6)
- [X] T042 Run `pnpm test && pnpm typecheck && pnpm lint` and the `quickstart.md` verification steps; fix any failures

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; BLOCKS all user stories.
- **User Stories (Phase 3–6)**: all depend on Foundational. Recommended order P1 → P2 → P3 → P4. US2 builds on US1's hook/controller; US3 and US4 build on US1's controller. US3 and US4 are otherwise independent of each other.
- **Polish (Phase 7)**: depends on the desired stories being complete (E2E in T039 assumes US1+US2).

### User Story Dependencies

- **US1 (P1)**: after Foundational. No dependency on other stories. = MVP.
- **US2 (P2)**: extends US1's `usePlaybackQa.ts` + `LiveTutorController.tsx` (T017/T019).
- **US3 (P3)**: persistence layer is self-contained (T027–T032); only the client wiring T033 depends on US1's controller.
- **US4 (P3)**: extends US1's prompt + controller (T013/T019/T020) and US3's persistence (T033 for the "no spurious exchange" check).

### Within Each User Story

- Tests written first and expected to FAIL before implementation.
- Repository/interface → service → route → client wiring.
- Library helpers (availability, current-item, token, context) before the route/controller that consume them.

### Parallel Opportunities

- Setup: T002 ∥ T001 (T001 first if lockfile contention).
- Foundational: T003, T005, T006, T007 in parallel (T004 after T003).
- US1 tests T008/T009/T010 in parallel; helpers T011/T012 in parallel; hook T017 parallel to server work.
- US3 T027/T028 in parallel; tests T025/T026 in parallel.
- Across stories: once Foundational is done, the US3 persistence layer (T027–T031) can be built in parallel with US1/US2 by a second developer.

---

## Parallel Example: User Story 1

```bash
# Tests for US1 together:
Task: "Contract test POST /api/lessons/{id}/live-session in apps/web/tests/contract/qa-api.test.ts"
Task: "Integration test live-tutor-session in apps/web/tests/integration/live-tutor-session.test.ts"
Task: "Unit test current-item resolver in apps/web/tests/unit/current-item.test.ts"

# Independent helper libs for US1 together:
Task: "Implement apps/web/lib/live-tutor/availability.ts"
Task: "Implement apps/web/lib/live-tutor/current-item.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → 4. **STOP & VALIDATE** the interrupt→answer→resume loop against a real agent → 5. demo.

### Incremental Delivery

Setup + Foundational → US1 (MVP) → US2 (barge-in) → US3 (transcripts) → US4 (guardrails). Each story is a deployable increment that doesn't break the previous.

### Parallel Team Strategy

After Foundational: Dev A on US1→US2 (realtime/UI), Dev B on US3 persistence layer (T027–T032) in parallel; converge on T033, then split US4.

---

## Notes

- [P] = different files, no incomplete-task dependency.
- Realtime transport, token mint, and `onMessage` are faked in CI (no live keys — Constitution Dev Workflow); the real ElevenLabs agent is exercised manually / via the faked-transport E2E.
- Barge-in, turn-taking, STT, and TTS are platform-owned — no task implements them (Principle IV).
- Keep persistence off the answer latency path (T033 posts after resume) to protect the <1.5s budget (Constitution I).
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
