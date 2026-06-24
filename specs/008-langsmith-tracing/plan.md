# Implementation Plan: Improve LangSmith Tracing for Live-Story Sessions

**Branch**: `008-langsmith-tracing` | **Date**: 2026-06-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-langsmith-tracing/spec.md`

## Summary

Live-story session traces are useless today: one flat self-reported node, no per-turn
hierarchy, no real telemetry, a misleading duration, and sessions that freeze `active` on
disconnect. The narration's Claude calls run inside ElevenLabs and never transit the app, so
the app can't observe them on its own. The plan **buys the telemetry from ElevenLabs**
(Constitution IV): an ElevenLabs post-call **OTel webhook** delivers per-session spans to a
new app route, which HMAC-verifies, correlates `conversation_id → lesson/owner` (a new
service-role repo lookup), enriches the OTLP `resourceSpans` with lesson/owner/thread
attributes, and forwards them to **LangSmith's OTLP ingest** — landing a real hierarchical
waterfall in the same lesson-keyed Thread as generation. A **10-minute scheduled sweep**
finalizes abandoned sessions so none freeze. Independently, **Tier A** fixes correct the
existing self-reported tracer (real start/end, per-turn child runs, metadata) so the
no-webhook / no-key path still degrades to a real per-turn trace. The one genuine unknown —
ElevenLabs span fidelity — sits behind a parser seam with a pre-decided JSON-payload fallback
(B1), so the spike's outcome swaps one module, not the architecture.

## Technical Context

**Language/Version**: TypeScript (strict) on Node 20 LTS (Constitution II).
**Primary Dependencies**: Next.js (App Router) · LangSmith SDK (existing soft dep) + LangSmith
**OTLP ingest** (`POST /otel/v1/traces`, plain `fetch`, no new dep) · ElevenLabs **post-call
webhook** (Conversational AI) · `@idiomatic/contracts` (Zod) · Supabase JS · the in-repo
structured logger. No new runtime dependency (Constitution II) — OTLP is forwarded with
`fetch`, not an OTel SDK exporter.
**Storage**: Supabase Postgres. Forward migration `0007_live_story_tracing.sql` adds
`live_sessions.last_activity_at` (+ index) and an index on `elevenlabs_conversation_id`. No
new table, no new bucket; realtime audio still never persisted (FR-011/025).
**Testing**: Vitest (unit + contract + integration), providers mocked; the captured webhook
payload + curl replay stand in for live delivery. Extends
`packages/generator/tests/unit/tracing-runtime.test.ts`.
**Target Platform**: Next.js server (Node runtime) on the existing host; webhook + sweep are
serverless API routes.
**Project Type**: Web (monorepo: `packages/*` + `apps/web`).
**Performance Goals**: Webhook relay off the speech path, best-effort; no learner-facing
latency budget. Sweep query bounded by `(status, last_activity_at)` index.
**Constraints**: Best-effort everywhere — tracing never throws into persistence or the live
session (FR-008); soft dependency — no `LANGSMITH_API_KEY` ⇒ full no-op (FR-010); secret
server-only (Constitution V); duration accuracy ±10% (SC-003); sessions finalized within 10
min of last activity (SC-002).
**Scale/Scope**: One trace per session; sweep batches stale sessions per tick. Single-digit
new files + one migration.

**Resolved unknowns**: see [research.md](./research.md). No `NEEDS CLARIFICATION` remain;
span fidelity is an implementation-time spike (R2) with a documented fallback, not a blocker.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **I. Voice-First Experience Quality** | ✅ N/A to the listener — observability only, fully off the speech path; cannot touch voice consistency, expressiveness, or interruption latency. |
| **II. One Language, End-to-End (TS/Node)** | ✅ All TypeScript. **No new runtime dependency** — OTLP forwarded via `fetch`, not an OTel SDK. Envelope + ports get explicit Zod/TS types. |
| **III. Evaluated, Reproducible Generation** | ✅ Strengthens reproducibility: every session's telemetry becomes recoverable and threaded with its generation run via the already-persisted `conversation_id`. Generation behavior unchanged. |
| **IV. Buy the Hard Parts, Build the Glue** | ✅ **Central design choice.** Telemetry of in-ElevenLabs LLM/TTS/tool calls is *bought* from ElevenLabs' OTel webhook, not reconstructed; the app builds only an unwrap-enrich-forward relay + correlation. No realtime capability reimplemented. |
| **V. Learner Data Integrity & Privacy** | ✅ Webhook secret + LangSmith key stay server-only; HMAC rejects forged deliveries (FR-007); owner-scoping preserved — unmatched deliveries are tagged, never mis-attributed (FR-005). Transcript content forwarded as-is, an accepted continuation of today's behavior (clarification Q3). The two service-role reads are the single audited cross-owner exception, justified below. |

**Gate result: PASS.** No violations → Complexity Tracking is empty.

The one item worth flagging (not a violation): the webhook + sweep are **not**
Auth0-authenticated and use **service-role** reads across owners. This is intrinsic — the
webhook caller is ElevenLabs (no learner session) and must look the owner *up* from the
conversation id. It is contained to two narrow, read-only-correlation methods + a status-only
sweep update, guarded by HMAC / cron secret, consistent with standard webhook design and
Constitution V (owner data still only surfaced to its owner's trace).

## Project Structure

### Documentation (this feature)

```text
specs/008-langsmith-tracing/
├── plan.md              # This file
├── spec.md              # Feature spec (+ Clarifications)
├── research.md          # Phase 0 — R1..R9 decisions
├── data-model.md        # Phase 1 — store change + ports + transient shapes
├── quickstart.md        # Phase 1 — configure / capture-spike / verify
├── contracts/           # Phase 1 — webhook + sweep OpenAPI, internal ports
│   ├── README.md
│   ├── otel-webhook.openapi.yaml
│   ├── sweep.openapi.yaml
│   └── ports.md
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/generator/src/observability/
├── session-tracer.ts            # MODIFY — Tier A: real start/end, per-turn child runs, metadata (R8/FR-013)
├── otlp-forward.ts              # NEW — soft fetch POST to LangSmith /otel/v1/traces (R7)
├── tracing-runtime.ts           # (unchanged; shared client/flush already in place)
└── index.ts                     # MODIFY — export the new forwarder

packages/generator/tests/unit/
└── tracing-runtime.test.ts      # EXTEND — assert child runs, start/end, metadata, forwarder soft-dep

packages/live-story/src/
├── services/
│   ├── otel-webhook-service.ts  # NEW — verify→parse→correlate→enrich→forward (orchestrator)
│   ├── otel-enrich.ts           # NEW — pure resourceSpans attribute injection (R4)
│   ├── hmac.ts                  # NEW — ElevenLabs signature verification (R6)
│   └── sweep-service.ts         # NEW — finalize stale active sessions (R5)
├── persistence/
│   ├── repository.ts            # MODIFY — add findSessionByConversationId + findStaleActiveSessions
│   └── in-memory-repository.ts  # MODIFY — impl the two new reads + last_activity_at bump
└── tests/
    ├── fixtures/otel-delivery.json   # NEW — captured payload (spike output) for replay tests
    └── unit/*.test.ts                # NEW — hmac, enrich, webhook-service, sweep, repo reads

apps/web/
├── app/api/live-story/elevenlabs/otel-webhook/route.ts  # NEW — unauthenticated, HMAC-guarded POST
├── app/api/live-story/sweep/route.ts                    # NEW — cron-secret-guarded POST
├── lib/config.ts                # MODIFY — webhook secret, OTLP endpoint/project, sweep secret, idle threshold
├── lib/container.ts             # MODIFY — wire OtelWebhookService + SweepService
└── lib/supabase/live-story-repository.ts  # MODIFY — impl the two service-role reads + last_activity_at

supabase/migrations/
└── 0007_live_story_tracing.sql  # NEW — last_activity_at (+ index), conversation_id index
```

**Structure Decision**: Follow the established 006/007 split. **Pure/portable logic** (HMAC,
enrichment, webhook orchestration, sweep, repo ports) lives in **`@idiomatic/live-story`**
(no Next/DOM); the **generic LangSmith OTLP forwarder** lives in
**`@idiomatic/generator/observability`** alongside the existing tracer and shared client; the
**web app** owns only the two thin API routes, env reading (`config.ts`), DI wiring
(`container.ts`), the Supabase repo impl, and the migration. This keeps the package
dependency direction one-way (app → packages) and every new boundary contract-testable
without a live service.

## Complexity Tracking

> No Constitution violations — section intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

## Phase 2 note

`/speckit.tasks` will derive the ordered task list. Expected task clusters, by user-story
priority and dependency order:

1. **Foundation** — migration `0007`; repo port additions + in-memory/Supabase impls +
   `last_activity_at` bumps; config keys. (Blocks US1–US3.)
2. **US1 (P1)** — `otlp-forward.ts`, `otel-enrich.ts`, `hmac.ts`, `otel-webhook-service.ts`,
   the webhook route, the capture-spike + fixture, contract/unit tests. **Plus Tier A**
   (`session-tracer.ts` fixes) as the parallel no-source floor (FR-013).
3. **US2 (P2)** — `sweep-service.ts` + sweep route + cron config + tests.
4. **US3 (P3)** — enrichment threading/correlation assertions end-to-end (mostly verification
   on top of US1's enrich + correlation).
5. **Polish** — quickstart validation, `pnpm test && pnpm typecheck && pnpm lint`.
