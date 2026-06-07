# Tasks: Parallelize Batch TTS Rendering

**Input**: Design documents from `/specs/004-tts-parallel-render/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/concurrency.md, quickstart.md

**Tests**: Included. The constitution's Development Workflow requires contract/boundary tests, and
plan.md specifies Vitest unit + integration coverage for the concurrency primitive and the render path.

**Organization**: Tasks are grouped by user story. The shared concurrency primitive and config plumbing
are foundational (both P1 stories consume them); each user story phase is then an independently testable
increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Exact file paths are included in each task

## Path Conventions

pnpm workspace (web app). Generator library: `packages/generator/src/` and `packages/generator/tests/`.
Web app: `apps/web/`. No new package; no DB/schema change.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Minimal scaffolding. No new runtime dependency; existing pnpm workspace.

- [X] T001 Create the `packages/generator/src/utils/` directory to host the new shared concurrency module (sibling to `adapters/`, `observability/`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared concurrency primitive and the configurable bound that BOTH P1 stories (US1, US2) and US3 build on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Write the unit test suite for `mapWithConcurrency` (write FIRST, must fail) in `packages/generator/tests/unit/concurrency.test.ts`, covering: input-order preservation under shuffled settle timing (C1); observed max concurrency `=== min(limit, items.length)` via an in-flight counter (C2); first-rejection propagates and halts new starts (C3); empty list → `[]`, mapper never called (C4); degenerate `limit` 0/negative clamps to 1 and runs ordered (C5); single item sanity.
- [X] T003 Implement `mapWithConcurrency<T, R>(items, mapper, limit)` in `packages/generator/src/utils/concurrency.ts` as a sliding worker pool (shared cursor, positional `results[i]` writes, clamp `limit >= 1`, empty→`[]`, fail-fast on first rejection, no logging/no domain coupling) to make T002 pass. Signature per `contracts/concurrency.md` §1.
- [X] T004 [P] Add `ttsBatchConcurrency: number` to `GeneratorConfig` and a sanitizing `TTS_BATCH_CONCURRENCY` parse (default `3`; absent/blank/non-integer/`< 1` → default; clamp `>= 1`; do NOT throw) in `packages/generator/src/config.ts`, wired into `loadGeneratorConfig`.
- [X] T005 Add `batchConcurrency: number` to the `ElevenLabsOptions` interface in `packages/generator/src/adapters/elevenlabs.ts` (type/field only; not yet consumed by the loop).
- [X] T006 Plumb `config.ttsBatchConcurrency` into the `ElevenLabsOptions.batchConcurrency` field where `ElevenLabsTtsAdapter` is constructed in `apps/web/lib/generation/deps.ts` (depends on T004, T005).

**Checkpoint**: The bounded-concurrency primitive exists and is unit-tested; the configurable bound flows from env → config → adapter options.

---

## Phase 3: User Story 1 - Faster lesson generation for multi-batch lessons (Priority: P1) 🎯 MVP

**Goal**: Render per-batch Text-to-Dialogue calls concurrently so a multi-batch lesson finishes materially faster, with output byte-equivalent to the sequential renderer.

**Independent Test**: Render a script forced into N>1 batches → stitched bytes equal a sequential concatenation in index order; a single-batch script is unchanged; a `render.batch` event fires for every batch. Wall-clock drops toward `sequential ÷ min(N, bound)`.

### Tests for User Story 1

- [X] T007 [P] [US1] Write the integration test in `packages/generator/tests/integration/render-parallel.test.ts`: stub `textToDialogue.convert` to return deterministic per-batch bytes; assert (a) a multi-batch script's stitched `RenderedAudio.bytes` equals the in-index-order concatenation of the stubbed per-batch outputs (FR-005/FR-006, RD3); (b) a single-batch script renders identically and emits exactly one `render.batch` (FR-012, RD7); (c) exactly `batchCount` `render.batch` events are emitted, one per `batchIndex` 0..N-1, via a capturing logger (FR-010, RD6).

### Implementation for User Story 1

- [X] T008 [US1] Rewrite the `renderDialogue` batch loop in `packages/generator/src/adapters/elevenlabs.ts` to render batches via `mapWithConcurrency(batches, renderOne, this.options.batchConcurrency)`, where `renderOne(batch, i)` performs the `convert()` call, collects bytes, and emits the existing `render.batch` event (with `batchIndex`, `batchCount`, `chars`, `durationMs`) from inside the mapper; stitch results with `concatBytes` in returned (index) order; `durationSeconds` computed unchanged (depends on T003, T005). Makes T007 pass.

**Checkpoint**: Multi-batch lessons render in parallel and produce identical audio; single-batch unchanged.

---

## Phase 4: User Story 2 - Generation stays within provider concurrency limits (Priority: P1)

**Goal**: Parallel rendering never exceeds the configured bound (so no 429s), the bound is operator-configurable with a safe default, and any batch failure fails the whole lesson with no partial audio.

**Independent Test**: With bound K and a script of N>K batches, an in-flight counter in the convert stub never exceeds K; a batch-failure stub rejects `renderDialogue` with no `RenderedAudio`; `TTS_BATCH_CONCURRENCY` parsing returns the default on invalid input.

### Tests for User Story 2

- [X] T009 [P] [US2] Write the config-parsing unit test in `packages/generator/tests/unit/config-concurrency.test.ts`: `TTS_BATCH_CONCURRENCY` unset/blank/non-integer/`<1` → `ttsBatchConcurrency === 3`; valid values respected; result always `>= 1` (FR-003, data-model config table).
- [X] T010 [P] [US2] Write the bound-enforcement integration test in `packages/generator/tests/integration/render-concurrency-bound.test.ts`: with `batchConcurrency = K` and a script forced into N>K batches, a `convert` stub tracking concurrent in-flight calls observes a max `<= K` (FR-002, RD2); and a stub that rejects one batch causes `renderDialogue` to reject with no `RenderedAudio` returned (FR-007, RD5).

### Implementation for User Story 2

- [X] T011 [US2] Document `TTS_BATCH_CONCURRENCY` in `.env.example` (with the existing TTS tuning vars `TTS_CHAR_LIMIT`/`ELEVENLABS_BITRATE`): note default `3`, per-plan guidance (Free 2 · Starter 3 · Creator 5 · Pro 10 · Scale/Business 15), that Free-tier MUST set `2`, and that `1` = sequential rollback (FR-004, quickstart).

**Checkpoint**: The bound is enforced and verified; misconfiguration degrades safely; failures fail-fast. US1 + US2 together are the shippable MVP.

---

## Phase 5: User Story 3 - Reusable bounded-concurrency primitive (Priority: P2)

**Goal**: Expose `mapWithConcurrency` on the `@idiomatic/generator` public API so future callers (item classification, S4 bulk regeneration) reuse it rather than re-implement concurrency control.

**Independent Test**: Import `mapWithConcurrency` from the package entry point and confirm it runs with the contracted order/cap/first-rejection behavior.

### Tests for User Story 3

- [X] T012 [P] [US3] Write a public-export test in `packages/generator/tests/unit/exports.test.ts` that imports `{ mapWithConcurrency }` from `@idiomatic/generator` (the package entry, not a relative path) and verifies it returns input-ordered results and respects the limit (FR-008/FR-009, contract §1).

### Implementation for User Story 3

- [X] T013 [US3] Add `export * from "./utils/concurrency";` (or named export) to `packages/generator/src/index.ts` so `mapWithConcurrency` is part of the package public API (depends on T003). Makes T012 pass.

**Checkpoint**: The primitive is reusable and contract-tested from the package boundary.

---

## Phase 6: User Story 4 - Learner knows the wait is expected (Priority: P3)

**Goal**: Set the expectation that generation can take a few minutes while a lesson is in progress.

**Independent Test**: View a `pending`/`generating` lesson → the in-progress banner notes generation can take a few minutes; once `ready`/`failed`, the note is gone.

### Implementation for User Story 4

- [X] T014 [US4] Extend the existing in-progress banner copy in `apps/web/app/lessons/[id]/page.tsx` (the `pending|generating` conditional, ~lines 84-90) to add a "Generation can take a few minutes." note alongside the existing "Creating your lesson…" line; keep it inside the existing status conditional so it disappears at `ready`/`failed` (FR-011, SC-005).

**Checkpoint**: All four user stories are independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Validation and backlog bookkeeping.

- [X] T015 Run the full gate: `pnpm test && pnpm typecheck && pnpm lint`, then perform the `quickstart.md` manual verification (generate a multi-batch lesson, confirm faster wall-clock vs `TTS_BATCH_CONCURRENCY=1`, correct play order, and the in-progress note).
- [X] T016 [P] Mark the TE1 row Spec/Plan/Tasks/Implemented status in `spec/STORY-MAP.md` (status tracker table).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS all user stories. (T002 before T003; T004/T005 before T006.)
- **US1 (Phase 3)**: Depends on Foundational (needs `mapWithConcurrency` from T003 and `ElevenLabsOptions.batchConcurrency` from T005).
- **US2 (Phase 4)**: Depends on Foundational; its integration test (T010) also exercises the US1 render loop (T008), so run after US1. The config unit test (T009) depends only on T004.
- **US3 (Phase 5)**: Depends on Foundational (T003). Independent of US1/US2 (internal callers use a relative import; the export is for external reuse).
- **US4 (Phase 6)**: Independent of all generator-side work (UI copy only) — can be done any time after Setup.
- **Polish (Phase 7)**: After all desired user stories.

### User Story Dependencies

- **US1 (P1)** → Foundational only.
- **US2 (P1)** → Foundational; enforcement integration test relies on US1's loop.
- **US3 (P2)** → Foundational only; otherwise independent.
- **US4 (P3)** → none (UI-only); fully independent.

### Within Each User Story

- Tests are written before implementation and must fail first (T002→T003, T007→T008, T009/T010→T011, T012→T013).
- Same-file tasks are sequential (the two `elevenlabs.ts` edits T005 then T008).

### Parallel Opportunities

- Foundational: T002 and T004 are `[P]` (different files); T005 is independent of T004.
- US4 (T014) can proceed in parallel with all generator work right after Setup.
- US3 (T012/T013) can proceed in parallel with US1/US2 once Foundational is done.
- Test-authoring tasks marked `[P]` (T007, T009, T010, T012) touch distinct files and can be written together.

---

## Parallel Example: after Foundational completes

```bash
# US1, US3, and US4 can be picked up concurrently (distinct files):
Task: "T007 [US1] integration test in packages/generator/tests/integration/render-parallel.test.ts"
Task: "T012 [US3] public-export test in packages/generator/tests/unit/exports.test.ts"
Task: "T014 [US4] in-progress banner copy in apps/web/app/lessons/[id]/page.tsx"
```

---

## Implementation Strategy

### MVP (both P1 stories)

1. Phase 1 Setup → Phase 2 Foundational (util + config + plumbing).
2. Phase 3 US1 (parallel render, byte-equivalent output).
3. Phase 4 US2 (bound enforced, safe default, fail-fast, documented).
4. **STOP and VALIDATE**: multi-batch lesson is faster, identical audio, no 429s. Ship.

### Incremental Delivery

- Add US3 (export the primitive) → reuse-ready for future features.
- Add US4 (UI note) → improved perceived wait.
- Polish: full gate + STORY-MAP update.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task.
- Output audio must remain byte-equivalent to the sequential renderer — the equivalence assertion (T007) is the guardrail for Constitution I.
- No DB/schema change, no new runtime dependency, no new package.
- Commit after each task or logical group.
