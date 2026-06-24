# Feature Specification: Improve LangSmith Tracing for Live-Story Sessions

**Feature Branch**: `008-langsmith-tracing`
**Created**: 2026-06-25
**Status**: Draft
**Input**: User description: "improve Langsmith Tracing based on next research — Langsmith-tracing.md"

## Overview

Today a live-narrated story session produces a LangSmith trace that is effectively
useless for debugging or quality work: a single flat node holding a self-reported
transcript dump, with no per-turn structure, no real latency/token/cost telemetry, a
misleading duration, and a record that freezes mid-conversation when a session
disconnects. The narration's LLM calls run inside the conversation platform and never
pass through the app, so the app cannot observe them on its own.

This feature makes live-story sessions genuinely observable. The conversation platform
already captures the missing telemetry (per-turn timing, time-to-first-token,
tool calls, call duration, cost, termination reason) and can deliver it when a call
ends. The feature brings that telemetry into LangSmith as a clean, hierarchical,
correctly-timed trace that lands in the same project and timeline as batch generation,
so a person reviewing a lesson sees the whole story — generation and every spoken
session — in one place.

## Clarifications

### Session 2026-06-25

- Q: How long after a session's last activity before the sweep force-closes it as abandoned? → A: 10 minutes
- Q: What to do when end-of-call telemetry arrives for a conversation id that matches no known session? → A: Still produce the trace, but uncorrelated — no lesson/owner enrichment, tagged "unmatched"
- Q: Privacy posture toward transcript/conversation text the platform's telemetry may carry? → A: Forward as-is (no added redaction or stripping; matches accepting today's transcript-in-trace behavior)
- Q: Concrete tolerance for "reported duration matches actual conversation length"? → A: ±10% (relative tolerance)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See a real, hierarchical trace with true telemetry for a completed session (Priority: P1)

A developer or quality reviewer opens LangSmith after a learner finishes a live-story
session and sees a trace that reflects what actually happened in the conversation:
the session as a parent, individual turns (and the model/tool activity inside them) as
children, with real timing, time-to-first-token, tool calls, call duration, and cost —
not a single flat blob.

**Why this priority**: This is the core value. Without real, structured telemetry the
trace cannot answer the questions people open LangSmith to ask ("why was that turn
slow?", "what did the agent call?", "how much did this session cost?"). Every other
story builds on having a real trace to look at.

**Independent Test**: Run one real live-story session to completion, then open the
session's trace in LangSmith and confirm it shows a parent-and-children hierarchy with
non-trivial per-turn timing, at least one latency metric, and a session cost — replacing
today's single flat node.

**Acceptance Scenarios**:

1. **Given** a live-story session that ran to completion, **When** its trace is viewed in
   LangSmith, **Then** the trace is a hierarchy (session parent with per-turn / per-call
   children), not a single node.
2. **Given** that same trace, **When** its telemetry is inspected, **Then** it reports the
   real conversation duration, per-turn latency/time-to-first-token where available, any
   tool calls the agent made, and the session's total cost.
3. **Given** a session whose telemetry source cannot be fetched or is malformed, **When**
   the trace is produced, **Then** the system degrades gracefully (a best-effort or no
   trace) and never disrupts the learner's session or transcript persistence.

---

### User Story 2 - Every session is captured and finalized, including disconnects (Priority: P2)

A reviewer can trust that every session that started shows up as a finalized trace —
including sessions where the learner closed the tab or lost connection without a clean
end — instead of a record frozen in an "active" state forever.

**Why this priority**: Today's trace finalizes only on a clean end-of-session signal from
the client, so disconnected or abandoned sessions freeze mid-conversation and silently
under-report. A trustworthy observability surface must account for every session,
otherwise reviewers cannot rely on what they see. It depends on P1's real-trace path but
adds the completeness guarantee on top.

**Independent Test**: Start a session and end it by abruptly disconnecting (no clean
end signal), then confirm that within a bounded time the session still appears in
LangSmith as a finalized trace with a real end time and a termination reason, not as a
perpetually "active" run.

**Acceptance Scenarios**:

1. **Given** a session that ends cleanly, **When** the trace is finalized, **Then** it has a
   correct end time and is marked complete.
2. **Given** a session that ends by disconnect/abandonment with no clean end signal,
   **When** a bounded settling period passes, **Then** the session is still captured as a
   finalized trace (with whatever turns and metadata exist) rather than left open.
3. **Given** any finalized session trace, **When** its summary attributes are viewed,
   **Then** it carries a termination reason and the turn counts so abandoned vs.
   completed sessions are distinguishable.

---

### User Story 3 - Generation and every session share one correlated timeline (Priority: P3)

A reviewer looking at a single lesson can follow it from batch generation through every
live session it produced, all threaded together and filterable by lesson and owner, in
the same LangSmith project.

**Why this priority**: Correlation is what turns individual traces into a story of a
lesson. It is high value but only meaningful once P1 produces real session traces; it is
an enrichment on top, not a prerequisite.

**Independent Test**: For one lesson, generate it and run two live sessions, then confirm
all three traces appear under one lesson-keyed thread in the same project and can be
filtered to that lesson and its owner.

**Acceptance Scenarios**:

1. **Given** a lesson with one generation run and multiple sessions, **When** its thread is
   viewed in LangSmith, **Then** generation and all sessions appear under one
   lesson-keyed timeline.
2. **Given** any session trace, **When** filtering by lesson or owner, **Then** the trace is
   tagged with both and is returned by the filter.
3. **Given** a session trace produced from the platform's telemetry, **When** correlation
   attributes are inspected, **Then** the session was matched back to its lesson and
   owner even though the telemetry source identifies the conversation by its own id.

---

### Edge Cases

- **Telemetry arrives late or out of order**: the end-of-call telemetry may arrive after
  the client already reported the session ended; the system must reconcile to one
  finalized trace, not produce two.
- **Telemetry never arrives**: if the platform never delivers end-of-call telemetry for a
  session, the completeness guarantee (US2) must still close the session out so it does
  not freeze.
- **Forged or unauthenticated delivery**: an inbound telemetry delivery whose authenticity
  cannot be verified MUST be rejected and never produce a trace.
- **Unknown conversation**: telemetry referencing a conversation that cannot be matched to
  a known session/lesson is still recorded as a trace but left uncorrelated and tagged
  "unmatched" — never silently attached to the wrong lesson.
- **No telemetry configured / no API key**: with the observability backend unconfigured,
  the entire path is a no-op and the learner experience is unaffected.
- **Sensitive content**: traces carry transcript text and conversation content, forwarded
  as-is from the platform's telemetry (no added redaction); this is accepted as consistent
  with today's transcript-in-trace behavior, and owner/lesson scoping stays intact.
- **Repeated delivery / retries**: the telemetry source may retry delivery; the same
  session must not produce duplicated or conflicting traces.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST produce, for each completed live-story session, a
  hierarchical trace (a session-level parent with per-turn and per-call children) rather
  than a single flat node.
- **FR-002**: The session trace MUST carry real telemetry sourced from the conversation
  platform — true conversation duration, per-turn timing, available latency/time-to-first
  metrics, tool calls, termination reason, and total session cost — not app-upsert
  wall-clock time.
- **FR-003**: The system MUST capture and finalize every session that starts, including
  sessions that disconnect or are abandoned without a clean end signal. A session with no
  activity for **10 minutes** MUST be force-closed by a sweep and finalized as abandoned.
- **FR-004**: Each session trace MUST be finalized with a correct start and end time
  derived from the actual conversation, not from persistence operation timing.
- **FR-005**: Each session trace MUST be enriched with the owning lesson and owner so it
  is filterable by both, even when the upstream telemetry identifies the conversation only
  by its own conversation id. When telemetry's conversation id matches no known session,
  the trace MUST still be produced but left uncorrelated (no lesson/owner enrichment) and
  tagged "unmatched".
- **FR-006**: Generation runs and all session traces for a lesson MUST share one
  lesson-keyed thread/timeline in the same observability project.
- **FR-007**: The system MUST verify the authenticity of inbound telemetry deliveries and
  reject unverified or forged deliveries without producing a trace.
- **FR-008**: The telemetry-ingest path MUST be best-effort and isolated: failures,
  malformed payloads, or backend outages MUST never disrupt the learner's live session,
  break transcript persistence, or return errors in a way that breaks the platform's own
  retry behavior.
- **FR-009**: Repeated or out-of-order telemetry deliveries for the same session MUST
  reconcile to a single finalized trace (no duplicates, no conflicting records).
- **FR-010**: The whole tracing path MUST remain a soft dependency: with the observability
  backend unconfigured (no API key), it MUST degrade to a no-op with no effect on the
  learner experience.
- **FR-011**: The system MUST preserve owner- and lesson-scoping of trace data. Transcript
  and conversation text carried by the platform's telemetry is forwarded as-is (no added
  redaction or stripping), consistent with today's accepted behavior of including the
  transcript in the trace.
- **FR-012**: Session-level summary attributes (scenario, status, turn counts,
  termination reason) MUST be present on the trace as filterable metadata/tags.
- **FR-013** *(independent quick win)*: The existing self-reported session trace MUST be
  corrected so that, absent the richer telemetry source, it no longer reports persistence
  wall-clock as conversation duration, emits per-turn structure, and stale "active"
  sessions are closed out rather than frozen.

### Key Entities *(include if feature involves data)*

- **Session Trace**: The observability record for one live-story session — a hierarchy of
  a session parent and per-turn/per-call children, carrying timing, latency, tool calls,
  cost, termination reason, and summary attributes; correlated to a lesson and owner.
- **Session Telemetry Delivery**: The end-of-call telemetry the conversation platform
  emits for a finished session, identified by a conversation id, that the system verifies,
  correlates to a known session, and turns into a Session Trace.
- **Lesson Thread**: The lesson-keyed timeline that groups a lesson's generation run and
  all of its session traces into one view.
- **Live Session record**: The existing durable transcript record (turns, scenario,
  status, conversation id, owner) that anchors correlation and the completeness sweep.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a completed session, a reviewer can identify the slowest turn and the
  session's total cost from its trace in under 1 minute — neither of which is possible
  today.
- **SC-002**: 100% of started sessions — including disconnected/abandoned ones — appear as
  finalized traces within 10 minutes of their last activity, with zero sessions left
  perpetually "active".
- **SC-003**: Reported session duration matches the actual conversation length within
  ±10%, instead of the current order-of-magnitude error from upsert timing.
- **SC-004**: 100% of session traces are filterable by lesson and by owner, and a lesson's
  generation run and all of its sessions appear under one thread.
- **SC-005**: 100% of unverified/forged telemetry deliveries are rejected and produce no
  trace.
- **SC-006**: Telemetry-ingest failures cause zero learner-facing session disruptions and
  zero transcript-persistence failures (the path is provably best-effort).
- **SC-007**: With the observability backend unconfigured, the live-story experience is
  unchanged (no-op tracing).

## Assumptions

- The conversation platform can deliver end-of-call telemetry for a session that includes
  per-turn timing, latency metrics, tool calls, call duration, cost, and termination
  reason, keyed by a conversation id the app already persists per session. The exact
  richness of the emitted telemetry is the make-or-break unknown to verify in a spike;
  if it proves too thin, an equivalently rich hand-built trace from the same delivery is
  the documented fallback — either way the observable outcomes above stand.
- The app already persists the conversation id alongside each session, enabling
  correlation back to lesson and owner.
- Exposing transcript/conversation content to the observability backend is acceptable
  because it matches today's behavior (the current trace already contains the transcript);
  this feature does not hand-pick additional private fields beyond what the platform emits.
- The existing self-reported tracer is retained as a no-key / no-telemetry fallback rather
  than deleted, so observability degrades gracefully when the richer source is absent.
- A publicly reachable ingest endpoint (production or staging, with a tunnel for local
  testing) and a shared verification secret are available to receive telemetry deliveries.
- The observability backend remains a soft dependency, consistent with all existing
  tracing in the project.

## Dependencies

- The conversation/voice platform's end-of-call telemetry delivery and its
  authenticity-verification mechanism.
- The existing observability backend (LangSmith project + ingest) and its current
  soft-dependency wiring.
- The existing durable live-session transcript and persisted conversation id used for
  correlation and the completeness sweep.
