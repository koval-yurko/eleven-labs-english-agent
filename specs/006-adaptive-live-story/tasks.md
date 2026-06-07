---
description: "Task list for 006-adaptive-live-story implementation"
---

# Tasks: Adaptive, Interruptible Live-Narrated Lesson

**Input**: Design documents from `/specs/006-adaptive-live-story/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Tests**: INCLUDED — the plan's Technical Context mandates Vitest (unit + contract + integration) with the realtime session / client tools / token mint mocked, plus a Playwright E2E, and lists concrete test files. The pure narration state machine and plan derivation are unit-tested without the SDK or a DOM.

**Organization**: Tasks are grouped by user story (P1 → P3) so each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: US1–US6 maps to the spec's user stories
- All paths are repo-relative; the project is the existing pnpm workspace

## Path Conventions

Additive to the existing workspace: `packages/contracts/`, `packages/generator/`, `apps/web/`, `supabase/migrations/`. New files are created; touched files are edited in place (per plan.md "Source Code").

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Configuration and feature-gate plumbing; no new runtime dependency (`@elevenlabs/react` already installed in 005).

- [X] T001 Add live-story env vars to `apps/web/.env.example`: `ELEVENLABS_STORY_AGENT_ID` (new) and a comment block documenting reuse of `ELEVENLABS_API_KEY`, `ELEVENLABS_TEACHER_VOICE_ID`, `TARGET_MIN_SECONDS`, `TARGET_MAX_SECONDS` (quickstart §2). Confirm no new client dependency is needed.
- [X] T002 [P] Surface `ELEVENLABS_STORY_AGENT_ID` and the target-length clamp window in `apps/web/lib/config.ts` (alongside the existing 005 live-tutor + `targetMin/MaxSeconds` config), with safe defaults and no secret leakage to the client.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared contracts, persistence schema, repository seam, and observability that EVERY user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 [P] Define live-story Zod schemas in `packages/contracts/src/live-story.ts`: `PlanItem`, `PlanBeat`, `LessonPlan`, `StartStoryToken`, `SessionTurnRole`, `SessionTurnKind`, `SessionTurn`, `LiveSession`, `AppendTurnRequest`, `TranscriptDTO`, and the client-tool I/O shapes — matching `contracts/live-story.schema.json` exactly (no `any` across boundaries; Constitution II).
- [X] T004 Export the new schemas from `packages/contracts/src/index.ts` (depends on T003).
- [X] T005 [P] Add `story.*` `EventId`s to `packages/generator/src/observability/events.ts`: `story.session`, `story.beat`, `story.coverage`, `story.scenario`, `story.turn`, `story.error`, `story.unavailable`.
- [X] T006 [P] Write migration `supabase/migrations/0005_live_story.sql`: enums `live_session_status`/`session_turn_role`/`session_turn_kind`, tables `live_sessions` + `session_turns` (with the `text` non-empty CHECK and `(session_id, turn_index)` UNIQUE), indexes, and owner-scoped RLS policies (select/insert/update; no delete) keyed on `auth.jwt() ->> 'sub'` — mirroring `0003_rls.sql`/`0004_qa.sql` and data-model.md §Migration.
- [X] T007 [P] Define the owner-scoped `LiveStoryRepository` interface in `apps/web/lib/live-story/repository.ts`: `openSession`, `appendTurns` (with in-place upsert of a teacher turn by `elevenTurnRef`), `updateScenario`, `endSession`, `setConversationId`, `listTranscript`.
- [X] T008 [P] Implement the test repo `apps/web/lib/live-story/in-memory-repository.ts` against the interface (depends on T007) — ordered turn-index assignment + barge-in correction upsert, owner-scoped.
- [X] T009 Implement the RLS-scoped Supabase repo `apps/web/lib/supabase/live-story-repository.ts` against the interface (depends on T007), using the same Auth0-subject scoping as `0004_qa.sql`.
- [X] T010 [P] Add `apps/web/lib/live-story/availability.ts` — `isLiveStoryConfigured()` (true only when `ELEVENLABS_API_KEY` + `ELEVENLABS_STORY_AGENT_ID` are present), mirroring 005's `lib/live-tutor/availability.ts`.
- [X] T011 [P] Contract test `apps/web/tests/contract/live-story-schema.test.ts` (or in `packages/contracts`): assert the Zod schemas accept/reject per `live-story.schema.json` (required fields, enums, `minItems`, role/kind consistency) (depends on T003).
- [X] T012 Wire the repository + (placeholder) services into `apps/web/lib/container.ts` DI, selecting in-memory vs Supabase repo by env exactly like the 002/005 seam (depends on T007, T008, T009).

**Checkpoint**: Contracts, schema, repo seam, and logging exist — user stories can begin.

---

## Phase 3: User Story 1 — Hear a lesson narrated live that teaches every planned item (Priority: P1) 🎯 MVP

**Goal**: Start a single realtime session that narrates a ready lesson aloud in the pinned teacher voice from a derived plan, teaching every planned item at least once and concluding within the target length — no `<audio>` element, no pre-rendered file.

**Independent Test**: Start a live narration, let it run uninterrupted; confirm it speaks in the teacher voice, covers every plan item at least once (`concludeLesson` blocked until covered), and ends within the bounded target length.

### Tests for User Story 1

- [X] T013 [P] [US1] Unit test `apps/web/tests/unit/derive-plan.test.ts` (or `packages/generator`): `derivePlan` from a `LessonScript` + `source_items` fixture — ordered items, beats grouped by `coverage`, `targetSeconds` clamp, and the "every item appears in some beat" assertion throws on a malformed script.
- [X] T014 [P] [US1] Unit test `apps/web/tests/unit/narration-state.test.ts` (US1 cases): coverage set, `advanceNarration` returns next beat / still-owed items / `conclude` only when all covered AND budget spent, and `concludeLesson` is rejected while any item is uncovered.
- [X] T015 [P] [US1] Contract test in `apps/web/tests/contract/live-story-api.test.ts` for `POST /api/lessons/{id}/live-story`: `200` `StartStoryToken` shape, `401` unauth, `404` not-found/owned, `409` not-ready.
- [X] T016 [P] [US1] Integration test `apps/web/tests/integration/live-story-session.test.ts`: plan derivation + faked token mint + a `LiveSession` row opened `active` + ownership enforcement + `409` for a non-ready lesson.

### Implementation for User Story 1

- [X] T017 [P] [US1] Implement the pure `derivePlan(script, items, { targetMinSeconds, targetMaxSeconds })` in `packages/generator/src/workflow/derive-plan.ts` per data-model.md §Plan derivation, and export it from `packages/generator/src/index.ts` (read-only; generation behavior unchanged).
- [X] T018 [P] [US1] Implement `apps/web/lib/live-story/plan-context.ts` — map a `LessonPlan` → dynamic variables (`lesson_summary`, `items_list`, `beats_outline`, `target_minutes`, `scenario`) + the scenario-pin text.
- [X] T019 [P] [US1] Author the VERSIONED narrator/tutor/steering system prompt + client-tool descriptions in `apps/web/lib/live-story/agent-prompt.ts` (narrate beat-by-beat, call `advanceNarration`/`markItemTaught`, conclude only when all items taught) — a tracked source artifact (Constitution III).
- [X] T020 [US1] Implement the pure narration state machine `apps/web/lib/live-story/narration-state.ts` (US1 scope): covered-set, current beat, length/beat budget (R8), and the completion guard so `advanceNarration` yields `conclude` only when covered + budget-spent and `concludeLesson` is rejected otherwise (depends on T017).
- [X] T021 [US1] Build the `clientTools` map in `apps/web/lib/live-story/client-tools.ts` for `advanceNarration`, `markItemTaught`, `concludeLesson` over `narration-state` (returns short instruction strings) (depends on T020).
- [X] T022 [US1] Implement `StartStoryService` in `apps/web/lib/live-story/service.ts`: derive plan, mint an owner-scoped token via the reused `lib/live-tutor/token.ts`, open a `LiveSession` row, and return `StartStoryToken`; emit `story.session`/`story.beat`/`story.coverage` via the injected logger (depends on T012, T017, T018).
- [X] T023 [US1] Implement `POST /api/lessons/{id}/live-story` in `apps/web/app/api/lessons/[id]/live-story/route.ts`: auth + ownership, `409` if not ready, call `StartStoryService`, return `StartStoryToken` (depends on T022).
- [X] T024 [P] [US1] Implement `apps/web/app/lessons/[id]/live-story/LiveStoryProvider.tsx` — the `@elevenlabs/react` ConversationProvider wrapper (connection type, dynamic variables, clientTools binding point).
- [X] T025 [US1] Implement `apps/web/app/lessons/[id]/live-story/useLiveStory.ts` — the hook binding SDK callbacks ↔ narration state machine and driving the `advanceNarration` self-continuation loop (depends on T020, T021).
- [X] T026 [US1] Implement `apps/web/app/lessons/[id]/live-story/LiveStoryController.tsx` — orchestration: POST to start, `sendContextualUpdate("Begin narrating … beat 1")` kickoff, run the beat loop, `endSession()` on conclude/stop/navigate; no `<audio>` element (depends on T023, T024, T025).
- [X] T027 [US1] Edit `apps/web/app/lessons/[id]/page.tsx` to offer **Live Story** for a `ready` lesson and mount the controller (depends on T026).

**Checkpoint**: A learner can start a live narration that teaches every planned item and ends within target — MVP complete and independently testable.

---

## Phase 4: User Story 2 — Steer the story scenario mid-session and keep learning every item (Priority: P2)

**Goal**: The learner can say "make this about space travel" mid-session; narration adapts, the new scenario stays pinned for the rest of the session (latest wins), and every planned item is still taught.

**Independent Test**: Start narration, change the scenario partway; confirm subsequent content uses the new setting, it persists to the end, and all items are still covered.

### Tests for User Story 2

- [X] T028 [P] [US2] Extend `apps/web/tests/unit/narration-state.test.ts` with scenario cases: `setScenario` updates state, latest-wins on repeated changes, scenario embedded in every `advanceNarration` return, and coverage still completes after a late scenario change.

### Implementation for User Story 2

- [X] T029 [US2] Extend `apps/web/lib/live-story/narration-state.ts` with scenario state (set/overwrite, latest-wins) and embed the pinned scenario in every `advanceNarration` return (FR-008/FR-009; depends on T020).
- [X] T030 [US2] Add the `setScenario(scenario)` tool to `apps/web/lib/live-story/client-tools.ts` — update state + return confirmation text (depends on T029).
- [X] T031 [US2] Add the intent rules (question vs. scenario-change; ambiguous/impossible → closest reasonable or "couldn't change setting", never garbage `setScenario`) to `apps/web/lib/live-story/agent-prompt.ts` (FR-011; depends on T019).
- [X] T032 [US2] In `LiveStoryController.tsx`/`useLiveStory.ts`, on `setScenario` re-pin via `sendContextualUpdate("From now on the story is set in: <scenario> …")` and record a `scenario_change` turn (depends on T026, T030).

**Checkpoint**: Scenario steering works, persists, and never breaks coverage — US1 + US2 both functional.

---

## Phase 5: User Story 3 — Interrupt to ask a spoken question and continue (Priority: P2)

**Goal**: The learner barges in with a question; narration stops promptly, a relevant spoken answer comes back in the teacher voice grounded in the current item, then narration resumes toward remaining items. Empty/unintelligible input asks to repeat without trapping the learner.

**Independent Test**: During narration, speak a question; confirm prompt stop, a relevant teacher-voice answer, and resumption toward not-yet-covered items; confirm a cough/silence yields a clarification prompt and a clean return after repeated unintelligibles.

### Tests for User Story 3

- [X] T033 [P] [US3] Extend `apps/web/tests/unit/narration-state.test.ts` with Q&A/guard cases: an answer exchange resumes narration toward remaining items, `unintelligible` input stores no turn and triggers clarification, and a `clarificationStreak` offers a clean "return to narration" after N tries (FR-016/FR-017, R9).

### Implementation for User Story 3

- [X] T034 [US3] Extend `apps/web/lib/live-story/narration-state.ts` with the barge-in Q&A path: answer exchange → resume toward remaining items, plus the `unintelligible` guard + `clarificationStreak`/`shouldOfferReturnToLesson` ported from 005's `exchange-state.ts` (depends on T020).
- [X] T035 [US3] Add the barge-in answer + empty/unintelligible rules to `apps/web/lib/live-story/agent-prompt.ts` — answer grounded in the current item, ask to repeat on empty input, never fabricate (FR-014/FR-016; depends on T019).
- [X] T036 [US3] In `useLiveStory.ts`, route a finalized learner turn through the state machine to distinguish question vs. clarification-needed and resume narration after the exchange (depends on T025, T034).

**Checkpoint**: Barge-in Q&A works with coverage preserved and no clarification trap — US1–US3 functional.

---

## Phase 6: User Story 4 — See live subtitle captions of both voices, corrected turn-by-turn (Priority: P3)

**Goal**: Subtitle-level captions of teacher and learner speech, finalized per turn and attributed; a barge-in-truncated teacher turn's caption is corrected to only what was actually spoken.

**Independent Test**: Run a session with a barge-in that cuts off the teacher mid-sentence; confirm both voices show as ordered, attributed, finalized captions and the interrupted teacher caption shows only spoken text.

### Tests for User Story 4

- [X] T037 [P] [US4] Extend `apps/web/tests/unit/narration-state.test.ts` (or a caption-reducer test) with the barge-in caption-correction case: `onAgentResponseCorrection` replaces the just-rendered teacher turn's text with `corrected_agent_response` (FR-020/SC-008).

### Implementation for User Story 4

- [X] T038 [US4] In `apps/web/app/lessons/[id]/live-story/useLiveStory.ts`, consume `onMessage` (`source:"ai"`→teacher, `source:"user"`→learner) as finalized turns and `onAgentResponseCorrection` to replace the teacher turn's text — a single corrected-text code path shared with persistence; do NOT consume `internal_tentative_agent_response` (R5; depends on T025).
- [X] T039 [US4] Implement `apps/web/app/lessons/[id]/live-story/CaptionLog.tsx` — ordered, attributed, finalized subtitle captions rendered from the caption state (depends on T038).

**Checkpoint**: Honest, corrected, attributed captions render live — US1–US4 functional.

---

## Phase 7: User Story 5 — Review the full session as a durable transcript later (Priority: P3)

**Goal**: The session (narration + Q&A, corrected text) persists incrementally to `live_sessions`/`session_turns`, survives abandonment, and is reviewable in a later session; no audio is retained.

**Independent Test**: Complete a session (with a barge-in cut-off), leave, return later, open the lesson, and confirm a full ordered, attributed, corrected-text transcript is present with no saved audio.

### Tests for User Story 5

- [X] T040 [P] [US5] Contract tests in `apps/web/tests/contract/live-story-api.test.ts` for `POST .../live-story/turns` (`201`, `400` invalid/blank/role-kind-inconsistent, append-ordering, in-place barge-in correction, scenario/ended/conversationId updates) and `GET .../transcript` (`200` `TranscriptDTO`, `401`, `404`).
- [X] T041 [P] [US5] Integration test `apps/web/tests/integration/live-story-transcript.test.ts`: incremental persist off the speech path, corrected-text upsert by `elevenTurnRef`, ordering preserved, ownership/privacy, and a partial transcript preserved when a session never ends (FR-027).

### Implementation for User Story 5

- [X] T042 [US5] Implement `apps/web/lib/live-story/transcript-service.ts` — append finalized turns (assign `turnIndex`, stamp `owner_id`, upsert teacher turn in place on barge-in correction), overwrite scenario (latest wins), mark ended, persist `elevenlabsConversationId`, and list the transcript; validation + RLS via the repo (depends on T007, T009, T012).
- [X] T043 [US5] Implement `POST /api/lessons/{id}/live-story/turns/route.ts` per `http-api.md` (auth, ownership, session belongs to lesson, `400` on invalid body) calling `transcript-service` (depends on T042).
- [X] T044 [US5] Implement `GET /api/lessons/{id}/transcript/route.ts` returning `TranscriptDTO` (sessions most-recent-first, turns ordered), owner-scoped, never returning audio (depends on T042).
- [X] T045 [US5] In `LiveStoryController.tsx`/`useLiveStory.ts`, persist finalized turns incrementally (best-effort, never on the speech/latency path) via `POST .../turns`, including the corrected teacher text and `ended` on conclude/stop (depends on T038, T043).
- [X] T046 [US5] Edit `apps/web/app/lessons/[id]/page.tsx` to fetch `GET .../transcript` and render the durable transcript review (ordered, attributed, corrected text; no audio player) (depends on T044).

**Checkpoint**: Sessions persist incrementally and are reviewable later — US1–US5 functional.

---

## Phase 8: User Story 6 — Clear fallback when the live session is unavailable (Priority: P3)

**Goal**: When live can't start (unconfigured / mint failure) or fails mid-session, show a clear message + retry / try-later — never a frozen or blank screen — with the partial transcript preserved on a mid-session drop.

**Independent Test**: Force unavailable at start and a failure mid-session; confirm each surfaces a clear message + usable retry and the learner is never stuck.

### Tests for User Story 6

- [X] T047 [P] [US6] Add `503`/unavailable cases to `apps/web/tests/integration/live-story-session.test.ts`: unconfigured (`isLiveStoryConfigured` false) and transient mint failure both yield a `503` fallback body; emits `story.unavailable` (FR-026, R7).

### Implementation for User Story 6

- [X] T048 [US6] In `StartStoryService` + `POST .../live-story` route, degrade to `503` with a fallback body when live is unavailable (unconfigured or mint failure) and emit `story.unavailable` (depends on T022, T023).
- [X] T049 [US6] Add the retry/try-later "live unavailable" panel to `apps/web/app/lessons/[id]/live-story/LiveStoryController.tsx` (start `503` → panel instead of live UI; `onError`/disconnect mid-session → clear message + retry, keep partial transcript), reusing 005's unavailable-panel pattern — no pre-render substitution (R7; depends on T026, T048).

**Checkpoint**: Robust fallback at start and mid-session — all user stories functional.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: End-to-end verification, docs, and the quality gate.

- [X] T050 [P] E2E `apps/web/tests/e2e/live-story-flow.spec.ts` with a faked conversation transport: narrate → barge-in question → resume; scenario-steer → coverage-still-complete; barge-in caption correction (desktop + mobile widths, FR-029/SC-013).
- [X] T051 [P] Update `CLAUDE.md` "Recent Changes"/architecture notes with the live-story subsystem (derive-plan helper, narration state machine, `story.*` events) and any new `pnpm` verification notes.
- [X] T052 Run the quickstart.md §5–6 verification manually (or document it) — happy path, guardrails (empty speech, late scenario, unavailable, abandon).
- [X] T053 Run `pnpm test && pnpm typecheck && pnpm lint` and resolve any failures before committing feature work.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; BLOCKS all user stories.
- **User Stories (Phases 3–8)**: all depend on Foundational. US1 (P1) is the MVP and is the foundation the others build on; US2–US6 each extend US1 surfaces but stay independently testable.
- **Polish (Phase 9)**: depends on the targeted user stories being complete.

### User Story Dependencies

- **US1 (P1)**: after Foundational. No dependency on other stories.
- **US2 (P2)**: extends the US1 state machine / controller (scenario). Independently testable.
- **US3 (P2)**: extends the US1 state machine / hook (Q&A + clarification). Independent of US2.
- **US4 (P3)**: extends the US1 hook (captions). Independent of US2/US3.
- **US5 (P3)**: persistence + review; consumes the corrected-text path from US4 for full fidelity but the routes/services are independently testable.
- **US6 (P3)**: fallback on the US1 start path + controller.

### Within Each User Story

- Tests (where listed) should be written and fail before implementation.
- Pure logic (`derive-plan`, `narration-state`) before client tools; client tools before service; service before route; route before UI.

### Parallel Opportunities

- Foundational `[P]` tasks T003, T005, T006, T007, T010 can run together (distinct files); T008/T009 follow T007; T011 follows T003.
- US1 tests T013–T016 `[P]` run together; impl `[P]` T017/T018/T019/T024 run together before the sequential T020→T021→T022→T023→T025→T026→T027 chain.
- After Foundational, US2/US3/US4 can be staffed in parallel by different developers (each touches a distinct extension surface), with care on the shared `narration-state.ts`/`agent-prompt.ts` files (serialize edits there).

---

## Parallel Example: User Story 1

```bash
# Tests for US1 together:
Task: "Unit test derive-plan in apps/web/tests/unit/derive-plan.test.ts"
Task: "Unit test narration-state (US1) in apps/web/tests/unit/narration-state.test.ts"
Task: "Contract test POST live-story in apps/web/tests/contract/live-story-api.test.ts"
Task: "Integration test live-story-session in apps/web/tests/integration/live-story-session.test.ts"

# Independent impl files for US1 together:
Task: "derivePlan in packages/generator/src/workflow/derive-plan.ts"
Task: "plan-context.ts in apps/web/lib/live-story/plan-context.ts"
Task: "agent-prompt.ts in apps/web/lib/live-story/agent-prompt.ts"
Task: "LiveStoryProvider.tsx in apps/web/app/lessons/[id]/live-story/LiveStoryProvider.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL) → 3. Phase 3 US1 → **STOP & VALIDATE** the live narration teaches every item and ends within target → demo.

### Incremental Delivery

Foundation → US1 (MVP) → US2 (steering) → US3 (Q&A) → US4 (captions) → US5 (transcript) → US6 (fallback). Each phase is an independently testable, shippable increment.

---

## Notes

- No new runtime dependency; `@elevenlabs/react` and the 005 token mint (`lib/live-tutor/token.ts`) are reused unchanged.
- The narration state machine and plan derivation are PURE — unit-tested without the SDK or a DOM.
- Realtime audio is NEVER persisted (FR-025); corrected text is the single source of truth for both captions and transcript.
- `derivePlan` is read-only over the persisted `LessonScript` — batch generation and its eval gate are untouched (Constitution III + subsystem independence).
