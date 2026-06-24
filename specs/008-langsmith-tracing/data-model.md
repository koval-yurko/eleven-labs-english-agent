# Phase 1 Data Model: Improve LangSmith Tracing for Live-Story Sessions

**Feature**: 008-langsmith-tracing · **Date**: 2026-06-25

This feature is **observability-first**: most "entities" are trace/telemetry shapes that
live in LangSmith or transit the relay, not new durable tables. The only persistent-store
change is two small additions to the existing `live_sessions` table to support correlation
and the sweep. No new tables. No new bucket.

---

## Persistent store changes (Supabase)

### `live_sessions` (existing — migration `0007_live_story_tracing.sql`)

Retained as-is plus:

| Column | Type | Change | Why |
|---|---|---|---|
| `elevenlabs_conversation_id` | `text` | **add index** `live_sessions_conversation_idx` | R3 correlation lookup keyed on conversation id (webhook has no owner) |
| `last_activity_at` | `timestamptz not null default now()` | **new column**, touched on every turn append / scenario update; **add index** `live_sessions_stale_idx (status, last_activity_at)` | R5 sweep query: find `active` sessions idle > 10 min |

- **State transitions** (unchanged enum `active → ended`), now reachable by **two** paths:
  1. clean client `ended:true` append (existing), or
  2. **sweep finalize** when `status='active' AND last_activity_at < now() - interval '10 minutes'` (new, R5) — sets `status='ended'`, `ended_at=now()`.
- `last_activity_at` is bumped on `appendTurns`, `updateScenario`, and `setConversationId`
  (any owner activity), so the sweep only closes genuinely idle sessions.
- **No schema change** to `session_turns`. **Realtime audio still never persisted** (FR-025/011).

**RLS**: existing owner-scoped policies unchanged. The new correlation lookup and the sweep
run with the **service-role** client (they legitimately operate across owners) — this is the
single audited exception (R3/R6), read-only for correlation and a narrow status update for the
sweep.

---

## Repository port additions (`LiveStoryRepository`)

Two new methods (in-memory + Supabase impls), both **service-role / non-owner-scoped** and
used only by the webhook + sweep:

```text
findSessionByConversationId(conversationId: string):
    Promise<{ sessionId: string; lessonId: string; ownerId: string } | null>
    // R3 correlation. null when no session carries that conversation id (→ "unmatched").

findStaleActiveSessions(idleOlderThan: Date, limit: number):
    Promise<Array<{ sessionId: string; lessonId: string; ownerId: string }>>
    // R5 sweep. active sessions whose last_activity_at < idleOlderThan, bounded by limit.
```

The existing owner-scoped `endSession(ownerId, sessionId)` is reused by the sweep (it has the
ownerId from `findStaleActiveSessions`), so no unscoped mutation is introduced.

---

## Transient shapes (not persisted)

### Session Telemetry Delivery — the ElevenLabs webhook envelope

Received at the webhook route, validated, then discarded after relay.

| Field | Type | Notes |
|---|---|---|
| `type` | `"post_call_transcription_otel"` \| `"post_call_transcription"` | discriminates OTel vs JSON-fallback body (R1/R2) |
| `event_timestamp` | number | delivery time |
| `data.conversation_id` | string | correlation key → `findSessionByConversationId` |
| `data.agent_id` | string | sanity check against the configured story agent |
| `data.otlp_traces.resourceSpans` | object[] | present when `type` is the OTel variant — the body forwarded to LangSmith |
| `data` (JSON variant) | object | `conversation_turn_metrics`, `tool_calls`, `metadata.cost`, `metadata.termination_reason`, transcript turns — parsed into a trace tree only on the B1 fallback branch |

Validated by a Zod schema (see `contracts/`). **Authenticity**: the raw body + the
`ElevenLabs-Signature` header are HMAC-verified *before* parsing (R6).

### Enriched OTLP payload — what the relay forwards to LangSmith

The received `resourceSpans` with injected **resource attributes**:

| Attribute | Source | Purpose |
|---|---|---|
| `langsmith.metadata.lessonId` | correlation lookup | filter by lesson (FR-005) |
| `langsmith.metadata.ownerId` | correlation lookup | filter by owner (FR-005) |
| `langsmith.metadata.thread_id` / session metadata | `= lessonId` | join the existing lesson Thread (FR-006, R4) |
| `langsmith.metadata.scenario` / `status` / `turnCount` / `termination_reason` | session record | filterable tags (FR-012) |
| `unmatched` tag | set when correlation misses | uncorrelated-but-traced (FR-005, clarification Q2) |

Forwarded verbatim-plus-attributes to `POST {LANGSMITH_ENDPOINT}/otel/v1/traces` with
`x-api-key` + `Langsmith-Project` headers (R7).

### Session Trace — the LangSmith artifact (no local persistence)

The resulting hierarchy in LangSmith: a session-level parent span with per-turn / per-call
children carrying duration, TTFB/latency, tool calls, cost, termination reason, and the
attributes above. On the **no-OTel / no-key** path it degrades to the corrected self-reported
run from `session-tracer.ts` (R8): one run per session, child run per turn, real
`start_time`/`end_time`, status/scenario/turnCount metadata.

---

## Entity relationship summary

```text
live_sessions (1) ──< session_turns (n)          [unchanged, owner-scoped]
      │  elevenlabs_conversation_id (now indexed)
      │  last_activity_at (new, indexed)
      │
      ├─ findSessionByConversationId ──► { sessionId, lessonId, ownerId }   (webhook correlation)
      └─ findStaleActiveSessions ──────► [ … ]                              (sweep)

ElevenLabs post-call webhook ─► Telemetry Delivery ─►(HMAC)► parse ─►(enrich w/ lesson/owner)─► OTLP forward ─► LangSmith Thread(thread_id = lessonId)
                                                                                                          ▲
generation traceable ─────────────────────────────────────────────────────────────────────────────────┘ (same thread)
self-reported tracer (Tier A, no-key fallback) ─────────────────────────────────────────────────────────┘
```
