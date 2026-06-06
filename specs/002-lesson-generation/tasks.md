---
description: "Task list for Generate a Story-Driven Podcast Lesson from a List"
---

# Tasks: Generate a Story-Driven Podcast Lesson from a List

**Input**: Design documents from `/specs/002-lesson-generation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included — the constitution's Development Workflow mandates contract tests on subsystem boundaries (the LessonScript schema), integration tests against provider mocks, and a generation eval gate. These are not optional for this feature.

**Organization**: Tasks are grouped by user story (US1 P1, US2 P2, US3 P3) so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3 — maps to spec.md user stories

## Path Conventions (pnpm workspace, per plan.md)

- `packages/contracts/` — shared Zod schemas + types (subsystem boundary)
- `packages/generator/` — Lesson Generator subsystem (Mastra workflow, render, evals)
- `apps/web/` — Next.js App Router app (UI + API route handlers + persistence)
- `supabase/migrations/` — Postgres schema, RLS, storage

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Workspace and tooling initialization

- [X] T001 Create pnpm workspace skeleton (root `package.json`, `pnpm-workspace.yaml`, empty `packages/contracts`, `packages/generator`, `apps/web` package manifests)
- [X] T002 [P] Add shared strict TypeScript base config in `tsconfig.base.json` and per-package `tsconfig.json` extending it (no implicit `any` across boundaries — Constitution II)
- [X] T003 [P] Configure ESLint + Prettier at repo root in `eslint.config.js` (flat config) and `.prettierrc`
- [X] T004 [P] Configure Vitest (root `vitest.workspace.ts` + workspace projects)
- [X] T005 [P] Create `.env.example` with all server-only keys per `quickstart.md` (Auth0, Supabase, Anthropic, ElevenLabs voice IDs, LangSmith)
- [X] T006 Scaffold Next.js App Router application in `apps/web/` (App Router, TypeScript)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core contracts, schema, auth, and persistence plumbing that every user story needs

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T007 [P] Define the `LessonScript` Zod schema (speakers, segments, coverage map, estimatedDurationSeconds) in `packages/contracts/src/lesson-script.ts`, mirroring `contracts/lesson-script.schema.json`
- [X] T008 [P] Define `Lesson`, `SourceItem`, `LessonAudio` DTOs and the `lesson_status` / `item_type` / `skip_reason` enums + `LessonStatus` API shape in `packages/contracts/src/lesson.ts`; re-export from `packages/contracts/src/index.ts`
- [X] T009 Create Supabase migration for enums and tables (`lessons`, `source_items`, `lesson_audio`) with indexes from data-model.md in `supabase/migrations/0001_init.sql` (RLS enabled; policies added in US2)
- [X] T010 [P] Create private audio Storage bucket + namespacing convention (`owner_id/lesson_id`) in `supabase/migrations/0002_storage.sql`
- [X] T011 Implement Auth0 session wiring + unauthenticated gating (middleware) in `apps/web/lib/auth/` and `apps/web/middleware.ts` (FR-017)
- [X] T012 [P] Server-only Supabase client factory (service-role server-side; per-request Auth0-JWT-scoped client) in `apps/web/lib/supabase/server.ts` — never imported by client components (Constitution V)
- [X] T013 [P] Provider adapter interfaces (Claude, ElevenLabs) + mock/fixture harness for CI in `packages/generator/src/adapters/` and `apps/web/tests/fixtures/` (research R11)
- [X] T014 [P] Shared JSON error envelope + typed API result helpers in `apps/web/lib/http.ts`
- [X] T015 [P] Config loader (teacher/learner voice IDs, model ids, `MAX_TEACHABLE_ITEMS=20`, length budget) in `packages/generator/src/config.ts` and `apps/web/lib/config.ts` (research R1)

**Checkpoint**: Foundation ready — user stories can begin.

---

## Phase 3: User Story 1 - Turn a word list into a story-driven audio lesson (Priority: P1) 🎯 MVP

**Goal**: An authenticated learner submits a valid list and receives one coherent ~5–10 min, two-voice lesson where every teachable item is taught through a mini-story, playable in the browser.

**Independent Test**: Submit 5–10 idioms → one ~5–10 min lesson, two distinct voices, every item taught via a story, playable.

### Tests for User Story 1 ⚠️ (write first, ensure they FAIL)

- [X] T016 [P] [US1] Contract test: `LessonScript` conformance against `contracts/lesson-script.schema.json` in `packages/generator/tests/contract/lesson-script.contract.test.ts`
- [X] T017 [P] [US1] Contract test: coverage guarantee — every accepted teachable item appears in the coverage map with ≥1 segment (FR-009/SC-002) in `packages/generator/tests/contract/coverage.contract.test.ts`
- [X] T018 [P] [US1] Integration test: generation lifecycle `pending → generating → ready` with mocked providers in `apps/web/tests/integration/generation-lifecycle.test.ts`
- [ ] T019 [P] [US1] Contract test: `POST /api/lessons` (202) and `GET /api/lessons/{id}` response shapes in `apps/web/tests/contract/lessons-api.test.ts`

### Implementation for User Story 1

- [X] T020 [P] [US1] Teachability classifier + normalize/dedupe (word/sentence/idiom, skip reasons) in `packages/generator/src/teachability.ts` (research R9)
- [ ] T021 [P] [US1] Versioned generation prompts (classify, plan-coverage, draft, expressive pass) in `packages/generator/src/prompts/` (Constitution III — no untracked strings)
- [ ] T022 [US1] Mastra workflow steps parse → classify → plan-coverage → draft → expressive pass → emit in `packages/generator/src/workflow/` (depends T020, T021, research R8)
- [X] T023 [US1] Coverage validation step (re-prompt uncovered items before accepting) in `packages/generator/src/workflow/validate-coverage.ts` (research R2)
- [ ] T024 [US1] ElevenLabs Text to Dialogue per-segment render + ordered stitch into one asset in `packages/generator/src/render/` (depends T013, research R5) — two distinct pinned voices (Constitution I); **measure the stitched asset's total duration (seconds)** and return it with the audio (SC-003)
- [X] T025 [US1] `generateLesson(input)` orchestrator returning `LessonScript` + stitched audio + reproducibility metadata (input, model id, prompt version) in `packages/generator/src/index.ts` (depends T022–T024)
- [X] T026 [US1] Generation bridge: create `pending` lesson **stamped with the caller's `owner_id` (Auth0 `sub`)** on the `lessons` + `source_items` inserts, run generator, advance status, write `script` + metadata in `apps/web/lib/generation/run.ts` (research R6; ownership required at first insert — FR-019)
- [X] T027 [US1] Upload stitched audio to private Storage and insert `lesson_audio` row, **persisting the measured `duration_seconds` (and mirroring it to `lessons.audio_duration_seconds`)** in the generation bridge (extends T024, T026; SC-003)
- [X] T028 [US1] `POST /api/lessons` happy path (≥1 teachable item → create `pending` owned by the authenticated caller, start generation, return 202 `LessonStatus`) in `apps/web/app/api/lessons/route.ts` (requires the T011 auth session for `owner_id`)
- [X] T029 [US1] `GET /api/lessons/{id}` status + detail (items, covered flags, audio when ready), scoped to the caller's `owner_id` in `apps/web/app/api/lessons/[id]/route.ts`
- [X] T030 [US1] `GET /api/lessons/{id}/audio` returning a short-lived signed URL in `apps/web/app/api/lessons/[id]/audio/route.ts` (FR-014)
- [X] T031 [P] [US1] Submit form UI (paste list, submit) in `apps/web/app/lessons/new/page.tsx`
- [X] T032 [US1] Lesson page: status display (pending/generating/ready) via Supabase Realtime + polling fallback in `apps/web/app/lessons/[id]/page.tsx` (FR-015)
- [X] T033 [US1] In-browser audio player on the lesson page (depends T030, T032)

**Checkpoint**: US1 fully functional — a learner can submit a valid list and play the generated lesson within the session. MVP.

---

## Phase 4: User Story 2 - Save, find, and replay lessons in a private account (Priority: P2)

**Goal**: Lessons + audio persist privately per learner; a learner returning in a later session finds and replays their lessons, and cannot see anyone else's.

**Independent Test**: Generate a lesson, sign out, sign back in → lesson + audio still present and playable; another account gets a 404.

### Tests for User Story 2 ⚠️

- [X] T034 [P] [US2] Integration test: cross-account access denied — Learner B gets 404 on Learner A's lesson/audio (FR-019/SC-005) in `apps/web/tests/integration/privacy.test.ts`
- [ ] T035 [P] [US2] Integration test: cross-session replay after re-login lists and plays prior lessons (FR-018/SC-006) in `apps/web/tests/integration/replay.test.ts`

### Implementation for User Story 2

- [X] T036 [US2] RLS policies on `lessons`, `source_items`, `lesson_audio` (`owner_id = auth.jwt() ->> 'sub'`, USING + WITH CHECK) in `supabase/migrations/0003_rls.sql` (research R7)
- [ ] T037 [US2] Configure Supabase to trust the Auth0 issuer as a third-party auth provider (RLS keys on Auth0 `sub`) — documented + applied in `supabase/README.md` / project config (research R7)
- [X] T038 [US2] Enforce owner scoping end-to-end: run all lesson reads/writes through the per-request Auth0-JWT-scoped Supabase client so RLS (T036) governs access, and audit existing handlers/bridge for any unscoped query (`apps/web/lib/supabase/`, `apps/web/lib/generation/run.ts`) — `owner_id` stamping itself lands in US1 (T026/T028)
- [X] T039 [US2] `GET /api/lessons` — list caller's lessons newest-first with item preview + counts (FR-020) in `apps/web/app/api/lessons/route.ts`
- [X] T040 [P] [US2] Library list UI (identify each lesson by item preview + creation time) in `apps/web/app/lessons/page.tsx`
- [X] T041 [US2] Harden audio signed-URL minting to be owner-scoped against the private bucket (extends T030, FR-019)

**Checkpoint**: US1 + US2 work — lessons are private, durable, and replayable across sessions.

---

## Phase 5: User Story 3 - Graceful handling of empty, oversized, or unteachable input (Priority: P3)

**Goal**: Empty, oversized, mixed, or unteachable input produces clear, actionable messaging instead of crashes/empty lessons; failed generation is retryable.

**Independent Test**: Submit nothing / 25 items / gibberish / valid+junk → clear distinct messages and correct outcomes; force a failure → retry works.

### Tests for User Story 3 ⚠️

- [X] T042 [P] [US3] Contract tests: empty → 400 `empty_input`, none-teachable → 400 `no_teachable_items`, over-limit → 413 `too_many_items` (FR-004/005/007) in `apps/web/tests/contract/lessons-guardrails.test.ts`
- [X] T043 [P] [US3] Integration test: mixed valid+unteachable input → lesson generated from valid items + skip report (FR-006) in `apps/web/tests/integration/mixed-input.test.ts`
- [X] T044 [P] [US3] Integration test: generation failure → status `failed` + `error_reason`; retry transitions to `generating` (FR-016) in `apps/web/tests/integration/retry.test.ts`

### Implementation for User Story 3

- [X] T045 [US3] Input guardrail branches in `POST /api/lessons`: empty → 400, no teachable → 400, > `MAX_TEACHABLE_ITEMS` → 413 (no silent drop) in `apps/web/app/api/lessons/route.ts` (extends T028)
- [X] T046 [US3] Persist + return per-entry skipped report (reason) on submit and in lesson detail (FR-006) in route handlers + `apps/web/app/lessons/[id]/page.tsx`
- [X] T047 [US3] `POST /api/lessons/{id}/retry` (only when `failed`, else 409) in `apps/web/app/api/lessons/[id]/retry/route.ts`
- [X] T048 [US3] Generation failure path: catch errors → set status `failed` + `error_reason` (no silent/indefinite wait) in `apps/web/lib/generation/run.ts` (extends T026)
- [X] T049 [US3] Guardrail + failure + retry messaging UI (inline errors on submit; failed state with retry affordance) in `apps/web/app/lessons/new/page.tsx` and `apps/web/app/lessons/[id]/page.tsx`

**Checkpoint**: All three user stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Quality gates, responsive verification, and hardening across stories

- [ ] T050 [P] Playwright E2E for submit → generate → replay across desktop + mobile viewports (SC-009) in `apps/web/tests/e2e/lesson-flow.spec.ts`
- [ ] T051 [P] LangSmith generation eval suite (coverage, length, story-not-definition, two-voice) + `pnpm eval:generation` gate in `packages/generator/src/evals/` (Constitution III)
- [ ] T052 [P] Wire `@mastra/langsmith` exporter for generation traceability in `packages/generator/src/workflow/`
- [ ] T053 [P] Update `README.md` / `CLAUDE.md` with run + verification instructions
- [ ] T054 Security hardening: assert no provider secrets in the client bundle, signed-URL TTL, RLS smoke test (Constitution V)
- [ ] T055 Run the `quickstart.md` verification matrix end-to-end

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)**: no dependencies.
- **Foundational (P2)**: depends on Setup — **blocks all user stories**.
- **US1 (P3)**: depends on Foundational. MVP.
- **US2 (P4)**: depends on Foundational; builds on US1's endpoints/persistence but is independently testable (privacy + cross-session replay).
- **US3 (P5)**: depends on Foundational; enhances US1's `POST /api/lessons` and the generation bridge, independently testable (guardrails + retry).
- **Polish (P6)**: depends on the desired user stories being complete.

### Story independence notes

- US1 delivers a playable lesson within a session (the MVP slice).
- US2 layers durable private persistence and the library — provable on its own via cross-account 404 and re-login replay.
- US3 layers input guardrails + retry onto the same submit endpoint — provable on its own via the rejection/mixed/retry cases.

### Within each story

- Tests written first and failing → models/schemas → services/workflow → endpoints → UI.
- Generator (`packages/generator`) and web app (`apps/web`) communicate only through the `LessonScript` contract.

---

## Parallel Opportunities

- **Setup**: T002, T003, T004, T005 in parallel (T001 first, T006 after).
- **Foundational**: T007, T008, T010, T012, T013, T014, T015 in parallel; T009/T011 sequential within their areas.
- **US1 tests**: T016, T017, T018, T019 in parallel (all fail first).
- **US1 impl**: T020 and T021 in parallel; then T022→T023→T024→T025; UI T031 parallel with API once endpoints exist.
- **US2 tests** T034, T035 in parallel; **US3 tests** T042, T043, T044 in parallel.
- **Cross-team**: once Foundational is done, US1/US2/US3 can be staffed in parallel given the seams above.

### Parallel example — US1 tests

```bash
Task: "Contract test LessonScript conformance in packages/generator/tests/contract/lesson-script.contract.test.ts"
Task: "Contract test coverage guarantee in packages/generator/tests/contract/coverage.contract.test.ts"
Task: "Integration test generation lifecycle in apps/web/tests/integration/generation-lifecycle.test.ts"
Task: "Contract test lessons API shapes in apps/web/tests/contract/lessons-api.test.ts"
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → **STOP & VALIDATE** (submit list → play lesson) → demo.

### Incremental delivery

1. Setup + Foundational → foundation ready.
2. US1 → test independently → MVP demo.
3. US2 → private persistence + replay → demo.
4. US3 → guardrails + retry → demo.
5. Polish → eval gate, responsive E2E, hardening.

---

## Notes

- [P] = different files, no incomplete dependencies.
- Verify each story's tests fail before implementing it.
- Teacher voice ID is fixed in config (T015) and reused unchanged by S2 (live tutor) — do not regenerate per lesson (Constitution I).
- CI runs against provider mocks/fixtures (T013); no live keys required for the test suite. The LangSmith eval (T051) is the separate generation-quality gate.
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
