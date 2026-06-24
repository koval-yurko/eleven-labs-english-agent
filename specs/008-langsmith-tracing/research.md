# Phase 0 Research: Improve LangSmith Tracing for Live-Story Sessions

**Feature**: 008-langsmith-tracing · **Date**: 2026-06-25
**Source brief**: `/Langsmith-tracing.md` (the originating research notes)

This document resolves the open technical questions from the spec's Technical Context so
Phase 1 design is unblocked. Each item is **Decision / Rationale / Alternatives**.

---

## R1 — Source of real telemetry: ElevenLabs post-call OTel webhook (Tier C)

**Decision**: Bring telemetry in via an ElevenLabs **post-call webhook** configured with
`transcript_format: opentelemetry`. ElevenLabs POSTs a wrapped envelope
(`type: "post_call_transcription_otel"`, `data.otlp_traces.resourceSpans`) to a new app
route when each call ends; the route unwraps `otlp_traces`, enriches it, and forwards the
`resourceSpans` to **LangSmith's OTLP ingest** (`POST /otel/v1/traces`,
`x-api-key` + `Langsmith-Project` headers). The forwarded body is already in LangSmith's
expected shape — the relay is unwrap-enrich-forward.

**Rationale**: The narration's Claude calls run *inside* ElevenLabs and never transit the
Next process, so `traceable`/`wrapAnthropic` cannot see them (the root cause of today's
useless flat trace). ElevenLabs is the only party that holds per-turn LLM/TTS/tool timing,
TTFB, cost, and termination reason. Buying that telemetry (Constitution IV — "buy the hard
parts, build the glue") yields a real waterfall with near-zero trace-building code.

**Alternatives considered**:
- **B1 — JSON webhook + hand-built tree** (`post_call_transcription`, default format):
  build a root run + child run per turn from `conversation_turn_metrics`, `tool_calls`,
  `metadata.cost`. **Kept as the documented fallback** (see R2) — same route, HMAC, and
  correlation plumbing, different body parser.
- **B2 — Pull on `ended:true`** (`GET /v1/convai/conversations/{id}`): no webhook infra,
  but misses sessions that never send a clean end signal and needs retry polling while the
  record is `status:processing`. Rejected as the primary path; the **sweep** (R5) covers
  the disconnect case more simply than turning every session into a poll.
- **Native OTLP from ElevenLabs to LangSmith directly**: ElevenLabs does not let you point
  an arbitrary OTLP endpoint with custom headers, so a thin relay is mandatory anyway.

---

## R2 — Span-fidelity unknown and the fallback branch

**Decision**: Treat the richness of ElevenLabs' emitted spans as the one **make-or-break
unknown**, resolved by a **capture spike during implementation** (dead-drop relay logs one
real payload), with a **pre-decided fallback**: if spans are rich (per-turn LLM w/ TTFB,
tool calls, TTS) → adopt the verbatim OTel forward; if thin/opaque → switch the route's
body parser to the **B1 hand-built tree** from the JSON payload. Either branch produces the
same observable outcomes (FR-001/002) and reuses the same route, HMAC, correlation, and
sweep.

**Rationale**: This is the only item that cannot be settled by reading docs — it needs one
real captured payload. The plan is deliberately structured so the make-or-break unknown
sits behind a parser seam (`parseTelemetry()` → normalized trace tree), and everything
downstream (enrichment, forward, correlation, sweep, Tier A) is identical regardless of
branch. So the spike's outcome changes one module, not the architecture. **This is not a
blocking NEEDS CLARIFICATION**: the default (forward verbatim) and the fallback both exist
and are specified.

**Alternatives considered**: Blocking the plan on a live capture — rejected; it would stall
design for a result that only swaps a parser implementation.

---

## R3 — Correlation: conversation_id → lesson/owner (new service-role lookup)

**Decision**: Add a **non-owner-scoped, service-role** repository method
`findSessionByConversationId(conversationId)` returning `{ sessionId, lessonId, ownerId }`
(or null). The webhook route is unauthenticated by Auth0 (ElevenLabs is the caller), so it
cannot start from an owner; it must look the owner *up* from the persisted
`elevenlabs_conversation_id`. When the lookup misses, the trace is still forwarded but left
**uncorrelated and tagged `unmatched`** (spec clarification Q2) — never attached to a guess.

**Rationale**: Every existing `LiveStoryRepository` method is owner-scoped (FR-028); the
webhook is the one legitimate caller that has no owner in hand. A single, explicitly
service-role, read-only lookup keyed on `conversation_id` is the minimal, auditable
exception. The column already exists (`live_sessions.elevenlabs_conversation_id`); it needs
an **index** for the lookup.

**Alternatives considered**: Passing owner/lesson as ElevenLabs dynamic variables and
reading them back from the spans — possible, but couples correlation to agent config and
still needs a fallback when absent; the DB lookup is the source of truth we already persist.

---

## R4 — Enrichment + threading into the existing LangSmith timeline

**Decision**: Before forwarding, inject `lessonId` and `ownerId` as **resource attributes**
on the `resourceSpans`, and set the trace's thread key to `lessonId` so it lands in the same
LangSmith Thread as generation and the self-reported tracer (which already keys
`thread_id` on `lessonId` — see `session-tracer.ts`). Add `scenario`/`status`/`turnCount`/
`termination_reason` as filterable attributes/tags.

**Rationale**: FR-006 requires generation + every session to share one lesson-keyed timeline.
Matching today's `thread_id = lessonId` convention makes the OTel trace slot into the
existing thread with no new correlation scheme. Resource attributes are the OTLP-native place
for cross-cutting identity.

**Alternatives considered**: Post-hoc tagging via the LangSmith REST API after ingest —
two round-trips and a race; resource attributes travel with the spans in one POST.

---

## R5 — Completeness: a 10-minute stale-session sweep

**Decision**: Add a **scheduled finalizer** (a cron-triggered, secret-guarded API route)
that finds `active` sessions whose last activity is older than **10 minutes** and finalizes
them — `endSession` + a finalized self-reported trace with `termination_reason: "abandoned"`.
Requires a `last_activity_at` column on `live_sessions` (touched on every append) and an
index to make the sweep query cheap.

**Rationale**: Today's trace finalizes only on a clean client `ended:true` append, so
disconnects freeze as `active` forever (FR-003, SC-002). A periodic sweep is simpler and
more reliable than per-session timers in a serverless runtime, and 10 minutes (clarification
Q1) comfortably exceeds normal webhook delivery so it rarely races a real end-of-call event;
when it does, the upsert-by-session-id reconciles to one trace (FR-009).

**Alternatives considered**:
- **Lazy sweep on read** (finalize stale sessions when the transcript is listed): zero infra,
  but a session no one ever re-opens stays `active` indefinitely — fails SC-002's guarantee.
- **Per-session setTimeout**: lost on process recycle in serverless; rejected.

---

## R6 — Webhook authenticity (HMAC) + best-effort posture

**Decision**: Verify the ElevenLabs webhook **HMAC signature** (shared secret
`ELEVENLABS_CONVAI_WEBHOOK_SECRET`) over the raw request body before doing anything; reject
unverified posts with a 401 and no trace (FR-007). Otherwise the route is **best-effort and
defensive**: it parses, correlates, forwards, and returns 200 even when forwarding fails, so
it never breaks ElevenLabs' own retry/back-pressure behavior in a harmful way, and it never
touches the learner's live session (FR-008).

**Rationale**: The route is a public, unauthenticated ingress; HMAC is the only thing
standing between it and forged traces. Constitution V keeps the secret server-only. Returning
2xx on internal forward failure (after a verified, well-formed delivery) avoids ElevenLabs
hammering retries for an outage on *our* downstream (LangSmith), which would not be fixed by
redelivery.

**Alternatives considered**: IP allow-listing (brittle, ElevenLabs egress not pinned);
no verification (rejected — forgeable trace injection).

---

## R7 — OTLP forwarding is separate from the SDK client

**Decision**: Implement a small **OTLP forwarder** (plain `fetch` to
`${LANGSMITH_ENDPOINT}/otel/v1/traces`) rather than routing through the existing
`SharedLangSmithClient`. Keep it soft: no `LANGSMITH_API_KEY` → no-op.

**Rationale**: `tracing-runtime.ts`'s `SharedLangSmithClient` wraps the **run create/update
REST API** (used by the self-reported tracer and generation `traceable`); LangSmith's **OTLP
ingest** is a different endpoint with a different body. Reusing the run API would mean
*not* using OTLP at all (back to hand-building). The forwarder shares the same key-detection
and soft-dependency conventions so behavior is consistent.

**Alternatives considered**: An OTel SDK exporter (`@opentelemetry/exporter-trace-otlp-http`)
— adds a runtime dependency to forward a body we already receive in final shape; rejected in
favor of a `fetch` POST (Constitution II keeps glue minimal, no new dep).

---

## R8 — Tier A: fix the self-reported tracer regardless (the no-OTel fallback)

**Decision**: Independently correct `session-tracer.ts` so that, even with **no** webhook /
OTel source: `start_time` comes from `session.createdAt`; `end_time` is set only on `ended`
(stop reporting upsert wall-clock as duration); emit a **child run per transcript turn**;
add `scenario`/`status`/`turnCount`/`termination_reason` as run metadata/tags. Covered by the
existing `tracing-runtime.test.ts` harness.

**Rationale**: These are cheap, high-value fixes worth doing regardless of the webhook bet
(FR-013), and they are exactly what the trace degrades to when the richer source is absent or
unconfigured (FR-010, SC-007) — so they are the graceful-degradation floor, not throwaway.

**Alternatives considered**: Delete the self-reported tracer once C is proven — rejected per
spec assumption (retain as the no-key / no-telemetry fallback).

---

## R9 — Local/dev reachability

**Decision**: The webhook needs a publicly reachable URL. Dev/test uses a **tunnel**
(e.g. an HTTPS tunnel to localhost) configured as the ElevenLabs webhook target; staging/prod
use the deployed URL. A **captured-payload curl replay** makes the relay testable repeatedly
without burning real sessions. Documented in `quickstart.md`.

**Rationale**: Webhook infra can't be exercised from unit tests alone; the replay fixture
makes everything after capture (parse → enrich → forward) unit-testable offline, leaving only
the one live capture as a manual step.

**Alternatives considered**: Staging-only testing (slower iteration); rejected in favor of
tunnel + replay fixture.

---

## Resolved unknowns summary

| Unknown (Technical Context) | Resolution |
|---|---|
| Telemetry source | ElevenLabs post-call OTel webhook → LangSmith OTLP relay (R1) |
| Span fidelity risk | Spike-captured, parser-seam isolated, B1 fallback (R2) |
| conversation_id → owner | New service-role `findSessionByConversationId` + index (R3) |
| Threading with generation | Resource attrs + `thread_id = lessonId` (R4) |
| Disconnect completeness | 10-min scheduled sweep + `last_activity_at` (R5) |
| Forgery / best-effort | HMAC verify + 2xx-on-downstream-failure (R6) |
| OTLP transport | Standalone `fetch` forwarder, soft dep (R7) |
| No-source degradation | Tier A fixes to `session-tracer.ts` (R8) |
| Dev reachability | Tunnel + curl replay fixture (R9) |

No `NEEDS CLARIFICATION` remain. Span fidelity is a tracked **implementation-time spike**
with a pre-decided fallback, not a design blocker.
