---
description: "Task list for 003-internal-logging"
---

# Tasks: Structured Internal Logging for Lesson Generation

**Input**: Design documents from `/specs/003-internal-logging/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/log-event.md, quickstart.md

**Tests**: INCLUDED. The spec defines an Independent Test + acceptance scenarios per story, and the plan/quickstart map each success criterion (SC-001..SC-008) to a verifying test. Providers stay mocked (Constitution Dev Workflow).

**Organization**: Tasks grouped by user story. This is the TE2 enhancement on top of the implemented S1 `lesson-generation` feature — it instruments existing pipeline seams; it adds no DB/schema, no new package, and no learner-facing change.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: US1 / US2 / US3 (user story phases only)

## Path Conventions

pnpm workspace (per plan.md): logger lives in `packages/generator/src/observability/`; instrumentation call-sites are existing files in `packages/generator/src/` and `apps/web/lib/`.

---

## Phase 1: Setup

**Purpose**: Configuration knobs for logging

- [ ] T001 [P] Add `LOG_LEVEL` (default `info`) and `LOG_PRETTY` (optional dev flag) with explanatory comments to `.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The structured logger core + correlation plumbing that ALL stories emit through

**⚠️ CRITICAL**: No story instrumentation (Phase 3+) can begin until the logger and the per-run child-logger plumbing exist.

- [ ] T002 [P] Define `Level`, the `EventId` taxonomy, and the `LogEntry` / `LogFields` / `LogContext` / `Logger` types per `contracts/log-event.md` in `packages/generator/src/observability/logger.ts` and `packages/generator/src/observability/events.ts`
- [ ] T003 [P] Implement secret redaction (key-name allowlist + value patterns → `"[redacted]"`) in `packages/generator/src/observability/redact.ts`
- [ ] T004 [P] Implement the no-op default logger in `packages/generator/src/observability/noop-logger.ts`
- [ ] T005 Implement the NDJSON logger (emit, level threshold filter, `child()` context merge, `LOG_PRETTY` rendering, per-emit `try/catch` isolation) in `packages/generator/src/observability/json-logger.ts` (depends T002, T003)
- [ ] T006 Add `packages/generator/src/observability/index.ts` barrel and re-export the observability surface from `packages/generator/src/index.ts` (depends T002–T005)
- [ ] T007 Add `LOG_LEVEL`/`LOG_PRETTY` to `packages/generator/src/config.ts` and a `createLogger(env)` factory (no-op vs JSON, honoring the knobs) in `apps/web/lib/generation/deps.ts` (depends T006)
- [ ] T008 Thread an optional per-run `logger` into `generateLesson` (default no-op, existing callers/tests unaffected) in `packages/generator/src/index.ts` (depends T004, T006)
- [ ] T009 Mint a child logger bound to `{ lessonId, ownerId }` in `apps/web/lib/generation/runner.ts` `run()` and pass it into the generation call (depends T007, T008)
- [ ] T010 Inject a logger into `LessonService`, mint `logger.child({ lessonId })` after `createPendingLesson` (and on `retry`), and wire it in `apps/web/lib/container.ts` in `apps/web/lib/lessons/service.ts` (depends T007)
- [ ] T011 [P] Add a capturing `Logger` test double (records entries in memory) in `packages/generator/tests/helpers/capturing-logger.ts` (depends T002)
- [ ] T012 [P] Unit test: level filtering drops sub-threshold entries; emitted `LogEntry` carries all required fields (`ts`/`level`/`event`/`lessonId`/`msg`) in `packages/generator/tests/unit/json-logger.test.ts` (depends T005, T011)
- [ ] T013 [P] Unit test: redaction yields zero matches against secret-name/value patterns in `packages/generator/tests/unit/redact.test.ts` (depends T003)
- [ ] T014 [P] Unit test: `child()` context merge, two-child disjointness, and emit-failure isolation (throwing serializer never propagates) in `packages/generator/tests/unit/logger-isolation.test.ts` (depends T005, T011)

**Checkpoint**: Logger emits correlated, level-filtered, redacted, isolated entries; correlation plumbing live in both `runner.ts` and `service.ts`. Story instrumentation can begin.

---

## Phase 3: User Story 1 - Trace one lesson's generation end-to-end by its id (Priority: P1) 🎯 MVP

**Goal**: Every pipeline stage emits a correlated, ordered entry so filtering by lesson id yields the complete trail; concurrent runs never bleed; reproducibility inputs are recoverable.

**Independent Test**: Generate a lesson with mocked providers, filter captured entries by its id → ordered entry per stage (teachability summary → draft → coverage → render total → result); a second concurrent run's entries never appear.

### Tests for User Story 1 ⚠️ (write first, ensure they FAIL)

- [ ] T015 [P] [US1] Integration test: per-lesson trail is complete and ordered when filtered by lesson id (SC-001) in `packages/generator/tests/integration/lesson-trail.test.ts`
- [ ] T016 [P] [US1] Integration test: two concurrent generations produce disjoint id-filtered trails (SC-007) in `packages/generator/tests/integration/concurrency-separation.test.ts`
- [ ] T017 [P] [US1] Integration test: `generate.result` makes input count, model id, and prompt version recoverable (SC-008) in `packages/generator/tests/integration/reproducibility.test.ts`

### Implementation for User Story 1

- [ ] T018 [US1] Emit `generate.draft` (attempt/maxAttempts/outcome; draft body @debug), `generate.coverage` (ok/result), and `generate.result` (itemCount/modelId/promptVersion/segments/coverage) through the per-run logger in `packages/generator/src/index.ts` (depends T008)
- [ ] T019 [US1] Emit `render.total` (bytes, audioDurationSeconds, renderDurationMs) by measuring wall-clock around `tts.renderDialogue` in `packages/generator/src/index.ts` (depends T018 — same file)
- [ ] T020 [US1] Emit `teachability.summary` (requested/accepted/skipped counts) via the service child logger in `apps/web/lib/lessons/service.ts` (depends T010)

**Checkpoint**: A whole lesson is traceable end-to-end by id (MVP). US2/US3 add lifecycle/failure and decision/timing depth.

---

## Phase 4: User Story 2 - Pinpoint where and why a generation failed (Priority: P2)

**Goal**: Lifecycle transitions and failures are visible from logs alone — failing stage + reason, with retries distinguishable.

**Independent Test**: Force a provider error in a mocked run → `lesson.status` shows `generating→failed` and a `generate.error` carries `{ stage, reason }`; a successful run shows `pending→generating→ready`.

### Tests for User Story 2 ⚠️ (write first, ensure they FAIL)

- [ ] T021 [P] [US2] Integration test: each lifecycle transition emits `lesson.status` with `from`/`to` (SC-004) in `apps/web/tests/integration/lifecycle-logging.test.ts`
- [ ] T022 [P] [US2] Integration test: failure emits `generate.error` with stage+reason and a `generating→failed` transition (SC-002) in `apps/web/tests/integration/failure-logging.test.ts`

### Implementation for User Story 2

- [ ] T023 [US2] Emit `lesson.status` for `pending→generating` and `generating→ready` (with `from`/`to`) in `apps/web/lib/generation/runner.ts` (depends T009)
- [ ] T024 [US2] In the `runner.ts` catch block, emit `generate.error` `{ stage, reason }` (derive stage from error type, e.g. `CoverageError`→coverage, else generation) and the `generating→failed` `lesson.status` in `apps/web/lib/generation/runner.ts` (depends T023 — same file)
- [ ] T025 [US2] Ensure retry re-entry logs a distinct `failed→generating` transition in the retry path of `apps/web/lib/lessons/service.ts` / `apps/web/lib/generation/runner.ts` (depends T024, T010)

**Checkpoint**: Failures are diagnosable from logs without re-running; lifecycle fully visible.

---

## Phase 5: User Story 3 - Diagnose low quality and performance from decision + timing detail (Priority: P3)

**Goal**: Per-item classification decisions, coverage re-prompts, and per-batch render timings are logged.

**Independent Test**: Generate from mixed valid/unteachable input with a forced first-draft coverage miss → logs show each item's decision+reason+type, the uncovered ids + a re-prompt, and a timing per TTS batch.

### Tests for User Story 3 ⚠️ (write first, ensure they FAIL)

- [ ] T026 [P] [US3] Integration test: per-item `teachability.item` records decision, itemType, and skip reason (raw text only @debug) in `apps/web/tests/integration/teachability-logging.test.ts`
- [ ] T027 [P] [US3] Integration test: `generate.coverage` reports uncovered ids and that a re-prompt occurred in `packages/generator/tests/integration/coverage-logging.test.ts`
- [ ] T028 [P] [US3] Integration test: a `render.batch` timing is present for every batch (SC-005) in `packages/generator/tests/integration/render-batch-logging.test.ts`

### Implementation for User Story 3

- [ ] T029 [US3] Emit `teachability.item` per item (decision/itemType/skipReason; `rawText` @debug only) via the service child logger in `apps/web/lib/lessons/service.ts` (depends T010; same file as T020)
- [ ] T030 [US3] Emit `generate.coverage` detail (uncovered ids + `reprompted` flag) around the `validateCoverage` re-prompt loop in `packages/generator/src/index.ts` (depends T018 — same file)
- [ ] T031 [US3] Add an optional `logger` param to `TtsAdapter.renderDialogue` and emit `render.batch` `{ batchIndex, batchCount, chars, durationMs }` per batch in `packages/generator/src/adapters/types.ts`, `packages/generator/src/adapters/elevenlabs.ts`, and `packages/generator/src/adapters/mock.ts` (depends T008)

**Checkpoint**: Quality and performance regressions are diagnosable from decision + timing detail.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T032 [P] Integration test: a full mocked generation run's emitted entries contain zero secrets across all events (SC-003) in `packages/generator/tests/integration/secret-scan.test.ts`
- [ ] T033 [P] Document logging usage (enable, filter by lesson id, levels, privacy) in `README.md` and add a generation-logging note to `CLAUDE.md`; confirm `.env.example` knobs match
- [ ] T034 Run the `quickstart.md` verification matrix and the standard gates: `pnpm test && pnpm typecheck && pnpm lint`

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: none — start immediately.
- **Foundational (Phase 2)**: depends on Setup — **blocks all stories**. Within it: T002/T003/T004 in parallel → T005 → T006 → T007 → {T008, T009, T010}; test scaffolding T011 then T012/T013/T014 in parallel.
- **User Stories (Phase 3–5)**: all depend on Foundational. US1 → US2 → US3 in priority order; they are value-independent but share instrumentation files (see notes), so run sequentially per file.
- **Polish (Phase 6)**: after the stories you intend to ship.

### Story independence notes

- **US1** is the MVP: end-to-end correlated trail + reproducibility. Shippable alone.
- **US2** adds lifecycle/failure visibility in `runner.ts` (independent of US1's generator-side emits).
- **US3** adds depth; its emit call-sites **share files with US1** — `service.ts` (T029 with T020) and `index.ts` (T030 with T018/T019). US3 therefore builds on US1-instrumented files; sequence US3 impl after US1 impl. Story *value* remains independently testable.

### Within each story

- Write the story's tests first and confirm they fail, then implement.
- Tasks touching the same file are sequential (not [P]); tasks in different files are [P].

## Parallel Opportunities

- **Setup**: T001 alone.
- **Foundational**: T002, T003, T004 in parallel; later T011, T012, T013, T014 in parallel.
- **US1 tests**: T015, T016, T017 in parallel (all fail first).
- **US2 tests**: T021, T022 in parallel. **US3 tests**: T026, T027, T028 in parallel.
- **Polish**: T032, T033 in parallel; T034 last.

### Parallel example — US1 tests

```bash
Task: "Integration: per-lesson trail complete & ordered in packages/generator/tests/integration/lesson-trail.test.ts"
Task: "Integration: concurrency separation in packages/generator/tests/integration/concurrency-separation.test.ts"
Task: "Integration: reproducibility summary recoverable in packages/generator/tests/integration/reproducibility.test.ts"
```

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (critical) → 3. Phase 3 US1 → **STOP & VALIDATE**: a lesson is fully traceable by id with reproducibility recoverable. Ship.

### Incremental delivery

Foundation → US1 (trace) → US2 (failure/lifecycle) → US3 (decision/timing depth) → Polish (secret-scan + docs + gates). Each story adds value without changing generation behavior.
