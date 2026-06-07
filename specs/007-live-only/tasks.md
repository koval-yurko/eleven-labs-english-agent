---
description: "Task list for feature 007-live-only implementation"
---

# Tasks: Live-Only Lesson Experience

**Input**: Design documents from `/specs/007-live-only/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/boundary-changes.md ✅, quickstart.md ✅

**Tests**: This is a retirement/refactor. No new TDD suite is requested; test tasks here only **delete** tests for removed behavior and **adjust** existing tests so the suite stays green (SC-007). They are integral to the change, not optional additions.

**Organization**: Tasks are grouped by user story. This feature *subtracts* surface area, so several stories are deletion-heavy. Because it is a cross-cutting refactor, "independent testability" is partly notional: a story's edits compile green only once its sibling consumers are updated — dependencies are called out explicitly per phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US4 (Setup/Foundational/Polish carry no story label)
- All paths are repo-root-relative and exact.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Capture a clean baseline before the retirement so regressions are attributable.

- [X] T001 Confirm branch `007-live-only` is checked out and capture the pre-change baseline by running `pnpm test && pnpm typecheck && pnpm lint` and noting current green/red state (audio + Q&A suites still present at this point).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Trim the one shared cross-subsystem contract field that every story's consumers compile against.

**⚠️ CRITICAL**: This contract edit cascades into the generator result, the lesson page, and the repositories. Removing it first makes the consumer edits in US1/US2/US4 a fix-the-compile-error exercise rather than a discovery exercise.

- [X] T002 Remove `audioDurationSeconds` from `LessonSummary` in `packages/contracts/src/lesson.ts`; keep `LESSON_STATUSES` (incl. `"ready"`) per D1. (Mirrored consumer fields are dropped in US1: T014–T017.)

**Checkpoint**: Foundation ready — user stories may begin (each completes its own consumer edits to reach green).

---

## Phase 3: User Story 1 - A generated lesson is ready without any audio render (Priority: P1) 🎯 MVP

**Goal**: `generateLesson` produces only `{ script, metadata }` (ordered items, story beats, two personas, coverage, bounded target length) and the web bridge marks a lesson `ready` on a valid script — no audio is synthesized, stitched, or stored.

**Independent Test**: Submit a valid list → lesson reaches `ready` with a derivable plan; `generateLesson` returns **no** `audio` field; the bridge calls **no** storage upload; no `lesson_audio` row / `lesson-audio` object is written (SC-001, SC-005, SC-006).

### Generator package (`packages/generator`)

- [X] T003 [P] [US1] Remove `RenderedAudio` and the TTS adapter interface from `packages/generator/src/adapters/types.ts`; keep `target*` fields on the generation request and the LLM adapter types.
- [X] T004 [P] [US1] Delete the server Text-to-Dialogue render adapter `packages/generator/src/adapters/elevenlabs.ts`.
- [X] T005 [US1] Drop `MockTtsAdapter` from `packages/generator/src/adapters/mock.ts`; keep `MockLlmAdapter`. (Same file as nothing else here — sequential after T003 since it references the removed types.)
- [X] T006 [US1] Drop `tts*` config from `packages/generator/src/config.ts`; **keep** `targetMinSeconds`/`targetMaxSeconds` and the voice ids (D2).
- [X] T007 [US1] In `packages/generator/src/index.ts` remove the TTS render stage and the `RenderedAudio`/`audio` field from `generateLesson`; return `{ script, metadata }` and return on a valid script (depends on T003–T006).
- [X] T008 [P] [US1] Drop audio fields from the traced output in `packages/generator/src/workflow/tracing.ts`.
- [X] T009 [P] [US1] Remove the `render.*` `EventId`s from `packages/generator/src/observability/events.ts`.

### Web generation bridge (`apps/web`)

- [X] T010 [P] [US1] Delete the `AudioStorage` port + in-memory impl `apps/web/lib/generation/storage.ts`.
- [X] T011 [P] [US1] Delete the Supabase audio storage adapter `apps/web/lib/supabase/audio-storage.ts`.
- [X] T012 [US1] Drop the TTS adapter wiring from `apps/web/lib/generation/deps.ts` (depends on T003–T005, T010–T011).
- [X] T013 [US1] In `apps/web/lib/generation/runner.ts` stop uploading audio and mark the lesson `ready` on a valid script alone (FR-004); ensure no status/error copy references audio render/length (FR-014) (depends on T007, T012).
- [X] T014 [US1] Drop the mirrored `audioDurationSeconds`/audio fields from `apps/web/lib/lessons/types.ts` (depends on T002).
- [X] T015 [US1] Remove `audio*` fields and any `getAudio` method from `apps/web/lib/lessons/repository.ts` and `apps/web/lib/lessons/in-memory-repository.ts` (depends on T014).
- [X] T016 [US1] Remove `getAudio`/audio mapping from `apps/web/lib/lessons/service.ts` (depends on T015).
- [X] T017 [US1] Drop the `lesson_audio` insert/read and the audio-duration column mapping from `apps/web/lib/supabase/lesson-repository.ts` (depends on T014).

### Tooling & tests for US1

- [X] T018 [P] [US1] Delete the render-path integration tests that exercise the removed TTS stage: `packages/generator/tests/integration/render-batch-logging.test.ts`, `render-parallel.test.ts`, and `render-concurrency-bound.test.ts`.
- [X] T019 [US1] Update `packages/generator/tests/unit/generate-lesson.test.ts` to assert `generateLesson` returns a valid script with full coverage + two distinct personas and **no** `audio` field; add/adjust a bridge assertion that a lesson is marked `ready` with **no** storage-upload call (SC-001) (depends on T007, T013).
- [X] T020 [US1] Edit `scripts/smoke-generate.ts` so it exercises only the Claude script path, asserts a valid script, and writes **no** `.mp3`/audio output (FR-011).

**Checkpoint**: Generation is plan-only and the bridge marks ready on script. US1 is independently testable via `pnpm test` (generator + bridge, providers mocked).

---

## Phase 4: User Story 2 - The lesson opens directly into the live story (Priority: P1)

**Goal**: A lesson page presents exactly one experience — the live-narrated story. No `<audio>` player and no separate playback-position Q&A panel are rendered.

**Independent Test**: Open a ready lesson → only the live-story panel (`LiveStoryProvider` + `TranscriptReview`) is present; no `<audio>` element and no `LiveTutorProvider` panel; starting it narrates live and turns persist to `live_sessions`/`session_turns` (SC-002).

**Dependency note**: Depends on T002 (page no longer reads `audioDurationSeconds`). Removing the `LiveTutorProvider`/audio usage here orphans the 005 UI + service files, which US4 then deletes.

- [X] T021 [US2] In `apps/web/app/lessons/[id]/page.tsx` remove the `<audio>` pre-rendered player element and the `LiveTutorProvider` wiring; keep the live-story panel + `TranscriptReview` as the sole experience (FR-005).
- [X] T022 [US2] In `apps/web/lib/container.ts` drop the `qaRepo` + `LiveTutorService` wiring so the lesson page's dependency graph resolves without the 005 Q&A surface (depends on T021).
- [X] T023 [US2] Update the Playwright e2e to assert the live-story-only flow on the lesson page (no `<audio>` element, no playback-Q&A panel) in `apps/web/tests/e2e/` (depends on T021–T022).

**Checkpoint**: Every learner reaches exactly one experience — the live story. US1 + US2 deliver the live-only product behavior (MVP).

---

## Phase 5: User Story 3 - Generation quality is judged on the script alone (Priority: P2)

**Goal**: The `pnpm eval:generation` gate scores only coverage, two-persona distinctness, and story-driven structure — no audio-render or audio-length criterion.

**Independent Test**: Run `pnpm eval:generation` → it passes/fails purely on script-level criteria; no `scoreLength`/`"length"` criterion remains; a script that omits an item or collapses the two personas fails (SC-003).

**Dependency note**: Independent of US1/US2/US4 source; can run any time after Setup. (`scoreLength` consumes the now-removed audio duration, so it must go regardless of US1 ordering.)

- [X] T024 [P] [US3] Delete `scoreLength`, `LengthWindow`, and the `"length"` `ScorerKey` from `packages/generator/src/evals/scorers.ts`; keep `scoreCoverage`, `scoreTwoVoice`, `scoreStoryNotDefinition` (D3).
- [X] T025 [US3] Remove the `lengthWindow` plumbing and the `scoreLength` call from `packages/generator/src/evals/harness.ts` (depends on T024).
- [X] T026 [US3] Remove the `lengthWindow`/live-TTS detection from `packages/generator/src/evals/run.ts`; keep the script scorers (depends on T024).
- [X] T027 [P] [US3] Drop any `length`/`LengthWindow` re-exports from `packages/generator/src/evals/index.ts` if present (depends on T024).
- [X] T028 [US3] Remove the length-scorer case and its import from `packages/generator/tests/eval/scorers.test.ts`; keep coverage / two-voice / story-not-definition cases (depends on T024).

**Checkpoint**: The quality gate matches the new script-only generation surface and stays enforced.

---

## Phase 6: User Story 4 - Retired data and surfaces no longer exist (Priority: P2)

**Goal**: The pre-rendered audio subsystem and the 005 playback-position Q&A subsystem — storage, records, routes, and code — are removed via a forward-only change. `live_sessions`/`session_turns` remain the single durable record.

**Independent Test**: Inspect the migrated DB → `lesson_audio`, `qa_exchanges`, `qa_turns` and the `lessons.audio_duration_seconds` column are gone; the `lesson-audio` bucket is gone; `live_sessions`/`session_turns` remain and round-trip. Former audio / `/live-session` / `/exchanges` URLs return 404 (SC-004, FR-009).

**Dependency note**: The UI/service/contract deletions here remove files that US2 (and US1) already stopped importing. The migration (T029) is independent of source changes.

- [X] T029 [P] [US4] Create migration `supabase/migrations/0006_retire_audio_qa.sql` dropping (in FK-safe order) `qa_turns`, `qa_exchanges`, the `qa_turn_role` enum, the `lesson-audio` bucket objects + bucket (+ its RLS policies), the `lesson_audio` table, and the `lessons.audio_duration_seconds` column — leaving `live_sessions`/`session_turns`/`source_items` untouched (data-model.md migration shape, D5).
- [X] T030 [P] [US4] Delete the 005 token-mint route `apps/web/app/api/lessons/[id]/live-session/route.ts` (former access ⇒ 404, FR-009).
- [X] T031 [P] [US4] Delete the 005 Q&A route `apps/web/app/api/lessons/[id]/exchanges/route.ts` (FR-009).
- [X] T032 [P] [US4] Delete the audio-serving route `apps/web/app/api/lessons/[id]/audio/route.ts` (signed-URL/getAudio surface ⇒ 404, D6/FR-009).
- [X] T033 [P] [US4] Delete the 005 Q&A UI under `apps/web/app/lessons/[id]/live-tutor/` (Provider/Controller/`usePlaybackQa`), now orphaned by T021.
- [X] T034 [US4] Delete all of `apps/web/lib/live-tutor/` **except** `token.ts` — i.e. `service.ts`, `current-item.ts`, `exchange-state.ts`, `context.ts`, `availability.ts`, `agent-prompt.ts`; **keep `token.ts` in place** (reused by live-story, D4) (depends on T022).
- [X] T035 [P] [US4] Delete the 005 Q&A persistence `apps/web/lib/qa/` (`service.ts`, `repository.ts`, `in-memory-repository.ts`) and `apps/web/lib/supabase/qa-repository.ts` (depends on T022).
- [X] T036 [US4] Delete `packages/contracts/src/qa.ts` and remove its `export * from "./qa"` line from `packages/contracts/src/index.ts`; keep `lesson-script.ts`/`live-story.ts` exports (depends on T035).
- [X] T037 [P] [US4] Delete the 005 contract tests `apps/web/tests/contract/qa-api.test.ts` and `apps/web/tests/contract/qa-schema.test.ts`.
- [X] T038 [P] [US4] Delete `scripts/create-live-tutor-agent.ts` and remove the `provision:agent` script entry from root `package.json` (005 agent setup retired; keep `provision:story-agent`).

**Checkpoint**: The retired records, storage, routes, and code no longer exist; the live-session transcript remains the single durable record.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Record the governance decision, scrub residual audio copy, and run the full gate.

- [X] T039 Amend `.specify/memory/constitution.md` via `/speckit.constitution`: bump **1.0.0 → 2.0.0 (MAJOR)**, reframe Principle I voice-consistency/expressiveness wording onto the pinned teacher voice + live narration (drop "scripted podcast"), and remove/reframe the "Scripted audio: ElevenLabs Text to Dialogue" stack line (FR-012, D7).
- [X] T040 [P] Audit status/error messaging on the generation path and lesson page for any remaining reference to audio rendering, audio length, or pre-rendered playback and remove it (FR-014) — grep `apps/web` and `packages/generator` for `audio`/`render`/`duration` copy.
- [X] T041 [P] Update `CLAUDE.md` (Active Technologies + generation/architecture notes) to reflect the live-only generation path and the removed audio/Q&A subsystems.
- [X] T042 Run the quickstart.md verification (`supabase db push` for `0006`, then the section 1–5 checks) and the final gate `pnpm test && pnpm typecheck && pnpm lint`; confirm the suite is green with audio + 005 Q&A coverage removed (SC-007).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: After Setup. T002 (contract trim) cascades into US1/US2/US4 consumer edits.
- **US1 (Phase 3, P1)**: After Foundational. The MVP backbone (generation goes plan-only).
- **US2 (Phase 4, P1)**: After Foundational (needs T002). Orphans 005 UI/services that US4 deletes.
- **US3 (Phase 5, P2)**: After Setup — independent of US1/US2/US4 source.
- **US4 (Phase 6, P2)**: Migration (T029) independent; the code deletions (T033–T036) require US2's T021–T022 (and US1) to have stopped importing the removed files.
- **Polish (Phase 7)**: After all desired stories; T042 is the final gate.

### User Story Dependencies

- **US1 (P1)**: Depends only on Foundational. Independently testable.
- **US2 (P1)**: Depends on Foundational; logically pairs with US1 for the live-only behavior. Its file-deletion fallout is completed in US4.
- **US3 (P2)**: Fully independent (the eval gate). Can be done at any point after Setup.
- **US4 (P2)**: Completes the retirement; its code deletions depend on US1/US2 having removed references.

### Within Each Story

- Contract/type edits before the consumers that read them.
- Adapter/port removals before the wiring (`deps.ts`/`container.ts`) that injects them.
- Source removal before deleting the now-orphaned files and their tests.

---

## Parallel Opportunities

- **US1 generator vs. web, deletions first**: T003, T004, T008, T009 (generator) and T010, T011, T018 (web/tests) are all `[P]` — different files, no cross-deps.
- **US3 in full** can run in parallel with all of US1/US2/US4 (separate `evals/` files).
- **US4 deletions**: T029, T030, T031, T032, T033, T035, T037, T038 are `[P]` — distinct files/routes.
- **Polish**: T040 and T041 are `[P]`.

### Parallel Example: User Story 1 (deletion wave)

```bash
# Independent file removals/edits — launch together:
Task: "Remove RenderedAudio + TTS interface in packages/generator/src/adapters/types.ts"   # T003
Task: "Delete packages/generator/src/adapters/elevenlabs.ts"                                 # T004
Task: "Drop audio fields in packages/generator/src/workflow/tracing.ts"                      # T008
Task: "Remove render.* EventIds in packages/generator/src/observability/events.ts"           # T009
Task: "Delete apps/web/lib/generation/storage.ts"                                            # T010
Task: "Delete apps/web/lib/supabase/audio-storage.ts"                                        # T011
Task: "Delete the 3 render-path integration tests in packages/generator/tests/integration/" # T018
```

### Parallel Example: User Story 4 (surface removal)

```bash
Task: "Create migration supabase/migrations/0006_retire_audio_qa.sql"               # T029
Task: "Delete apps/web/app/api/lessons/[id]/live-session/route.ts"                  # T030
Task: "Delete apps/web/app/api/lessons/[id]/exchanges/route.ts"                     # T031
Task: "Delete apps/web/app/api/lessons/[id]/audio/route.ts"                         # T032
Task: "Delete apps/web/app/lessons/[id]/live-tutor/ UI"                             # T033
Task: "Delete apps/web/lib/qa/ + lib/supabase/qa-repository.ts"                     # T035
Task: "Delete apps/web/tests/contract/qa-api.test.ts + qa-schema.test.ts"          # T037
Task: "Delete scripts/create-live-tutor-agent.ts + provision:agent in package.json"# T038
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Phase 1 Setup → Phase 2 Foundational (T002).
2. Phase 3 US1 — generation goes plan-only; **validate** with `pnpm test` (no `audio` field, ready without upload).
3. Phase 4 US2 — lesson page renders only the live story; **validate** with e2e.
4. At this point the product *behaves* live-only (SC-001, SC-002, SC-005, SC-006).

### Incremental Delivery

1. MVP (US1+US2) → live-only behavior.
2. US3 → quality gate matches the new surface (SC-003) — parallelizable, can land anytime.
3. US4 → the migration + dead-code/route removal realizes the cost & surface reduction (SC-004) and turns former entry points into 404s.
4. Polish → constitution amendment (FR-012), copy scrub (FR-014), docs, final green gate (SC-007).

---

## Notes

- `[P]` = different files, no dependency on incomplete tasks.
- `lib/live-tutor/token.ts` is **kept in place** (reused by live-story, D4) — do not delete or move it (the directory name being historical is accepted).
- Forward-only: previously rendered audio and 005 Q&A transcripts are discarded; this loss is accepted (FR-007). No feature flag/compatibility shim (FR-013).
- No auth/ownership/RLS redesign (FR-015) — only the retired records/storage/routes and the audio-render path are removed.
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
