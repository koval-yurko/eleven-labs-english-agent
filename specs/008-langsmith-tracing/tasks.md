# Tasks: Improve LangSmith Tracing for Live-Story Sessions

**Input**: Design documents from `/specs/008-langsmith-tracing/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: INCLUDED — the plan + `contracts/ports.md` define contract tests on every new
boundary, and the constitution requires contract tests on subsystem boundaries with external
services mocked. Live webhook delivery is the only path not unit-covered (a captured fixture +
curl replay stands in).

**Organization**: Grouped by user story (US1=P1, US2=P2, US3=P3) for independent delivery.

## Path Conventions

Monorepo (per plan.md): pure/portable logic in `packages/live-story/src/`, the generic
LangSmith forwarder in `packages/generator/src/observability/`, thin routes + wiring +
migration in `apps/web/` and `supabase/migrations/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Configuration surface the routes and services read.

- [X] T001 Add tracing env keys to `apps/web/lib/config.ts`: a `liveStoryTracingConfig(env)` reader exposing `webhookSecret` (`ELEVENLABS_CONVAI_WEBHOOK_SECRET`), `sweepSecret` (`CRON_SECRET`), `langsmithEndpoint` (`LANGSMITH_ENDPOINT`, default `https://api.smith.langchain.com`), `langsmithProject` (`LANGSMITH_PROJECT`), and `sweepIdleMinutes` (default 10) — all server-only, never returned to the browser (Constitution V).
- [X] T002 [P] Document the new env vars (webhook secret, cron secret, OTLP endpoint/project) in `README.md` and any `.env.example`, noting the soft-dependency no-op behavior.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DB + repository changes every user story builds on (correlation, sweep query,
activity tracking). **⚠️ No user story can begin until this phase is complete.**

- [X] T003 Create forward migration `supabase/migrations/0007_live_story_tracing.sql`: add `live_sessions.last_activity_at timestamptz not null default now()`, index `live_sessions_stale_idx (status, last_activity_at)`, and index `live_sessions_conversation_idx (elevenlabs_conversation_id)`. No new table/bucket; `session_turns` untouched.
- [X] T004 Extend the repository port in `packages/live-story/src/persistence/repository.ts`: add `SessionCorrelation` type and `findSessionByConversationId(conversationId): Promise<SessionCorrelation | null>` + `findStaleActiveSessions(idleOlderThan: Date, limit: number): Promise<SessionCorrelation[]>` (both documented service-role / non-owner-scoped per R3/R6).
- [X] T005 Implement the two new reads + `last_activity_at` bumps in `packages/live-story/src/persistence/in-memory-repository.ts`: bump `last_activity_at` in `appendTurns`/`updateScenario`/`setConversationId`; implement both new queries against the in-memory store.
- [X] T006 [P] Implement the two new reads + `last_activity_at` bumps in `apps/web/lib/supabase/live-story-repository.ts` (service-role client; correlation lookup and sweep query use the new indexes; bump `last_activity_at` on the same three mutations).
- [X] T007 [P] Contract test the repository additions in `packages/live-story/tests/unit/live-story-repository-tracing.test.ts` (against the in-memory impl): `findSessionByConversationId` returns the row across owners and null when unknown; `findStaleActiveSessions` returns only `active` rows older than the cutoff, respects `limit`, excludes `ended` and freshly-touched rows; an append bumps `last_activity_at` so a just-appended session is NOT swept.

**Checkpoint**: Correlation + sweep queries + activity tracking exist and are tested. User stories can now proceed.

---

## Phase 3: User Story 1 - Real, hierarchical trace with true telemetry (Priority: P1) 🎯 MVP

**Goal**: A completed session produces a hierarchical LangSmith trace with real per-turn
telemetry, via the ElevenLabs OTel webhook → LangSmith OTLP relay; and the no-webhook/no-key
path still degrades to a real per-turn trace (Tier A).

**Independent Test**: Replay a captured `post_call_transcription_otel` payload through the
webhook route and confirm a parent+children waterfall with per-turn timing, a latency metric,
and session cost renders in LangSmith; with `LANGSMITH_API_KEY` unset the route returns
`no_sink` and nothing breaks.

### Tests for User Story 1 ⚠️ (write first, ensure they fail)

- [X] T008 [P] [US1] Contract test the telemetry envelope schema in `packages/live-story/tests/unit/telemetry-delivery.test.ts`: a captured OTel fixture parses, a captured JSON-variant fixture parses, a truncated/garbage body fails `safeParse`.
- [X] T009 [P] [US1] Contract test HMAC verification in `packages/live-story/tests/unit/hmac.test.ts`: a correctly-signed `{timestamp}.{rawBody}` passes; wrong secret, tampered body, and missing header all fail.
- [X] T010 [P] [US1] Contract test the pure enricher in `packages/live-story/tests/unit/otel-enrich.test.ts`: `lessonId`/`ownerId` attributes present on output; `unmatched:true` omits lesson/owner and adds the `unmatched` tag.
- [X] T011 [P] [US1] Contract test the OTLP forwarder in `packages/generator/tests/unit/otlp-forward.test.ts`: no `LANGSMITH_API_KEY` → `{ok:false, reason:"no_sink"}` and no fetch call; with key → POST to `${endpoint}/otel/v1/traces` carrying `x-api-key` + `Langsmith-Project`; a non-2xx downstream → `{ok:false, reason:"forward_failed"}`.
- [X] T012 [P] [US1] Extend `packages/generator/tests/unit/tracing-runtime.test.ts` for Tier A: captured `createRun` payload has one child run per turn, `start_time` from the session's `createdAt` (not wall-clock), `end_time` only when ended, and `scenario`/`status`/`turnCount`/`termination_reason` metadata.
- [X] T013 [US1] Integration test the webhook route in `apps/web/tests/integration/otel-webhook.test.ts` (mocked fetch + in-memory repo): valid signature + known conversation → enriched spans forwarded (`status:forwarded`); unknown conversation → `status:unmatched` (forwarded, no lesson/owner); bad signature → 401, no forward; no `LANGSMITH_API_KEY` → `status:no_sink`; a forward failure still returns 200 (FR-008).

### Implementation for User Story 1

- [X] T014 [P] [US1] Define the `TelemetryDelivery` Zod schema + type in `packages/live-story/src/services/telemetry-delivery.ts` (discriminates `post_call_transcription_otel` vs `post_call_transcription`; `data.conversation_id`/`agent_id` required; `passthrough`).
- [X] T015 [P] [US1] Implement ElevenLabs HMAC-SHA256 verification over the raw body in `packages/live-story/src/services/hmac.ts` (parse `t=,v0=`, constant-time compare; pure, secret injected).
- [X] T016 [P] [US1] Implement the pure `enrichResourceSpans(resourceSpans, { lessonId, ownerId, unmatched })` in `packages/live-story/src/services/otel-enrich.ts` (R4 — lesson/owner attrs + `unmatched` tag; threading attrs added in US3).
- [X] T017 [P] [US1] Implement the soft OTLP forwarder `forwardOtlpToLangSmith(resourceSpans, { project, env, fetchImpl })` in `packages/generator/src/observability/otlp-forward.ts` (R7 — `fetch` POST, no new dep; no-key → `no_sink`); export it from `packages/generator/src/observability/index.ts` and `packages/generator/src/index.ts`.
- [X] T018 [US1] Implement `OtelWebhookService` in `packages/live-story/src/services/otel-webhook-service.ts` orchestrating verify → parse → `findSessionByConversationId` → enrich → forward, returning `{status: forwarded|unmatched|no_sink}`; best-effort, never throws (depends on T014–T017 + T004).
- [X] T019 [US1] Add the webhook route `apps/web/app/api/live-story/elevenlabs/otel-webhook/route.ts` (unauthenticated by Auth0; reads the raw body for HMAC; calls the service; maps to 200/400/401; never 5xx on downstream failure) (depends on T018).
- [X] T020 [US1] Wire `OtelWebhookService` into `apps/web/lib/container.ts` (`getOtelWebhookService()`), injecting the service-role live-story repo, the forwarder, and `liveStoryTracingConfig()`.
- [X] T021 [US1] **Tier A** (FR-013): in `packages/generator/src/observability/session-tracer.ts` add `createdAt` to `SessionTrace`, set `start_time` from it, set `end_time` only on `ended`, emit a child run per turn, and add `scenario`/`status`/`turnCount`/`termination_reason` run metadata; update `packages/live-story/src/services/transcript-service.ts` to pass `createdAt` into the trace.
- [~] T022 [US1] **Capture spike** (R2): with the dead-drop relay, run one real story session, save the raw envelope to `packages/live-story/tests/fixtures/otel-delivery.json`, and record the span-fidelity decision (verbatim OTel forward vs B1 JSON hand-built) in `research.md`. If thin, add the JSON parser branch behind the same `OtelWebhookService` seam.

**Checkpoint**: US1 fully functional — a real hierarchical trace renders from the webhook, and the self-reported tracer degrades gracefully. **This is the MVP.**

---

## Phase 4: User Story 2 - Capture & finalize every session, including disconnects (Priority: P2)

**Goal**: A scheduled sweep finalizes sessions idle > 10 min so none freeze `active`, each
getting a finalized trace tagged `abandoned`.

**Independent Test**: Start a session, skip the clean `ended` signal, wait past the threshold
(or call the sweep), and confirm the session is `ended` with `termination_reason: abandoned`
and a finalized trace; a re-run finalizes nothing (idempotent).

### Tests for User Story 2 ⚠️

- [X] T023 [P] [US2] Contract test `SweepService` in `packages/live-story/tests/unit/sweep-service.test.ts`: finalizes only stale `active` sessions, skips already-`ended` ones (idempotent → single finalized trace, FR-009), respects the batch limit, and records a finalized trace with `termination_reason: "abandoned"` per closed session.
- [X] T024 [P] [US2] Integration test the sweep route in `apps/web/tests/integration/live-story-sweep.test.ts`: missing/invalid cron secret → 401; valid secret → `{finalized, scanned}` and the stale session is now `ended`.

### Implementation for User Story 2

- [X] T025 [US2] Implement `SweepService` in `packages/live-story/src/services/sweep-service.ts`: `findStaleActiveSessions(now - idle, limit)` → for each, `endSession(ownerId, sessionId)` + record a finalized `SessionTrace` (`ended:true`, `termination_reason:"abandoned"`) via the injected `SessionTracer`; best-effort (depends on T004/T021).
- [X] T026 [US2] Add the sweep route `apps/web/app/api/live-story/sweep/route.ts` (cron-secret guarded; calls the service; returns `{finalized, scanned}`) and wire `getSweepService()` in `apps/web/lib/container.ts`.
- [X] T027 [US2] Configure the schedule (cron) to POST `/api/live-story/sweep` periodically (deployment cron config + a note in `quickstart.md`/`README.md`).

**Checkpoint**: US1 + US2 work independently — abandoned sessions no longer freeze.

---

## Phase 5: User Story 3 - Generation & every session share one correlated timeline (Priority: P3)

**Goal**: Every session trace is threaded under `thread_id = lessonId` (same as generation)
and filterable by lesson and owner, with session summary tags.

**Independent Test**: For one lesson with a generation run and two sessions, confirm all three
appear under one lesson-keyed Thread in the same project and filter by lesson/owner.

### Tests for User Story 3 ⚠️

- [X] T028 [P] [US3] Extend `packages/live-story/tests/unit/otel-enrich.test.ts`: thread key equals `lessonId` when present, and `scenario`/`status`/`turnCount`/`termination_reason` appear as filterable attributes.
- [X] T029 [US3] Integration test threading in `apps/web/tests/integration/live-story-trace-threading.test.ts`: a forwarded session trace carries `thread_id = lessonId` and lesson/owner filter attributes, matching the generation tracer's thread convention (FR-006).

### Implementation for User Story 3

- [X] T030 [US3] Extend `enrichResourceSpans` in `packages/live-story/src/services/otel-enrich.ts` to inject `thread_id = lessonId` plus `scenario`/`status`/`turnCount`/`termination_reason` resource attributes (R4/FR-006/FR-012), and have `OtelWebhookService` (T018) pass the session's scenario/status/turnCount through (depends on T016/T018).

**Checkpoint**: All three stories independently functional; generation + sessions share one timeline.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T031 [P] Add `story.trace`/`story.sweep`/`story.unavailable`-style `EventId`s to `packages/generator/src/observability/events.ts` and emit them (best-effort) from the webhook + sweep services for operability.
- [X] T032 [P] Update `CLAUDE.md` "Adaptive live story note" / add a tracing note documenting the webhook relay, sweep, Tier A, and the soft-dependency posture.
- [~] T033 Run `quickstart.md` end-to-end validation (capture → replay → verify hierarchy/correlation/sweep/degradation).
- [X] T034 Run `pnpm test && pnpm typecheck && pnpm lint` and resolve any failures.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; **blocks all user stories**.
- **US1 (Phase 3)**: depends on Foundational. The MVP.
- **US2 (Phase 4)**: depends on Foundational; independent of US1 (reuses the Tier A tracer from T021 — if US2 is built before T021, fold the `createdAt`/metadata tracer change in first).
- **US3 (Phase 5)**: depends on Foundational + US1's `enrichResourceSpans`/`OtelWebhookService` (extends the same files).
- **Polish (Phase 6)**: after the desired stories.

### Within Each User Story

- Tests written first and failing, then implementation (constitution: contract tests on boundaries).
- Schema/pure helpers (`telemetry-delivery`, `hmac`, `otel-enrich`, `otlp-forward`) before the orchestrating service before the route before DI wiring.

### Parallel Opportunities

- **Setup**: T002 ∥ T001.
- **Foundational**: T006 (Supabase) ∥ T007 (in-memory contract test) after T004/T005; T003 (migration) independent.
- **US1 tests**: T008–T012 all [P] (different files). **US1 impl**: T014–T017 all [P] (different files) before T018.
- **US2 tests**: T023 ∥ T024.
- Across stories: once Foundational is done, US1 and US2 can be staffed in parallel; US3 follows US1.

---

## Parallel Example: User Story 1

```bash
# Failing tests first (different files, parallel):
Task: "Contract test telemetry envelope in packages/live-story/tests/unit/telemetry-delivery.test.ts"
Task: "Contract test HMAC in packages/live-story/tests/unit/hmac.test.ts"
Task: "Contract test enricher in packages/live-story/tests/unit/otel-enrich.test.ts"
Task: "Contract test OTLP forwarder in packages/generator/tests/unit/otlp-forward.test.ts"
Task: "Extend tracing-runtime.test.ts for Tier A child runs/metadata"

# Then pure helpers (different files, parallel):
Task: "TelemetryDelivery schema in packages/live-story/src/services/telemetry-delivery.ts"
Task: "HMAC verify in packages/live-story/src/services/hmac.ts"
Task: "enrichResourceSpans in packages/live-story/src/services/otel-enrich.ts"
Task: "forwardOtlpToLangSmith in packages/generator/src/observability/otlp-forward.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL) → 3. Phase 3 US1 (incl. Tier A + capture spike).
4. **STOP and VALIDATE**: replay a captured payload, confirm a real waterfall in LangSmith.
5. Deploy/demo — this alone replaces the useless flat trace.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → real trace + graceful degradation (MVP).
3. US2 → no session ever freezes.
4. US3 → one correlated lesson timeline.

### Notes

- [P] = different files, no incomplete dependencies.
- The one make-or-break unknown (span fidelity) is isolated to T022 behind the `OtelWebhookService` parser seam — its outcome swaps a parser, not the architecture.
- Everything is best-effort and soft: no `LANGSMITH_API_KEY` ⇒ full no-op; tracing never throws into the live session or persistence.
- Commit after each task or logical group; verify tests fail before implementing.

---

## Implementation status (executed 2026-06-25)

All tasks implemented and the full gate is green: **`pnpm typecheck` ✓ · `pnpm test` (201
tests, 42 files) ✓ · `pnpm lint` ✓**. New tests: repo-tracing, telemetry-delivery, hmac,
otel-enrich, otlp-forward, session-tracer (Tier A), otel-webhook (integration), sweep-service,
live-story-sweep (integration), live-story-trace-threading (integration).

Two tasks are **partial (~)** because they require a live ElevenLabs session + LangSmith account
that cannot run in this environment — their offline portions are complete:

- **T022 (capture spike)**: a representative synthetic `post_call_transcription_otel` fixture is
  committed (`packages/live-story/tests/fixtures/otel-delivery.json`) and the verbatim-OTel
  forward path is implemented behind the `OtelWebhookService` parser seam. The make-or-break
  decision (verbatim vs B1 JSON hand-built) still needs ONE real captured payload to confirm span
  fidelity; if thin, add the JSON parser branch at the documented seam. Replace the synthetic
  fixture with the real capture when available.
- **T033 (quickstart end-to-end)**: steps 2–5 (replay → correlation → sweep → graceful
  degradation) are covered offline by the integration tests; step 1 (configure the ElevenLabs
  dashboard webhook + run a real session) and the live LangSmith waterfall check remain a manual
  verification against a deployed/tunnelled URL.
