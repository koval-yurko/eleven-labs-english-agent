# Feature Specification: Structured Internal Logging for Lesson Generation

**Feature Branch**: `003-internal-logging`  
**Created**: 2026-06-06  
**Status**: Draft  
**Input**: User description: "Structured internal logging for the lesson generation pipeline. Today logging is effectively limited to REST/request edges; internal functionality (generation pipeline steps, teachability decisions, coverage validation, TTS batch timings, and lesson status transitions) is opaque when debugging a failed or low-quality lesson. Add structured, levelled JSON logging across the generator workflow steps, generation bridge/runner status transitions (pending→generating→ready|failed), teachability classification, coverage validation, and TTS batch render timings; correlate entries by lesson id; redact secrets. Out of scope: third-party APM vendor and log-shipping infrastructure; LangSmith eval-trace export."

## User Scenarios & Testing *(mandatory)*

The consumers of this feature are the **engineers and operators** who build, debug, and run the lesson-generation system — not the end learner. The feature changes nothing in the learner-facing UI; its value is observability of work that is currently a black box.

### User Story 1 - Trace one lesson's generation end-to-end by its id (Priority: P1) 🎯 MVP

An engineer is told that a specific lesson "came out wrong" or never finished. They take that lesson's id and retrieve every internal step the system performed for it — input parsing, teachability decisions, coverage planning and validation, audio rendering, and the final outcome — as an ordered, structured trail, without re-running the generation.

**Why this priority**: This is the core value. The whole reason for the feature is that today, when a lesson is bad or fails, there is no record of what the pipeline actually did. A correlated, per-lesson trail is the minimum that makes the system debuggable and satisfies the reproducibility principle (Constitution III). Everything else refines this.

**Independent Test**: Generate a lesson, capture its id, and confirm that filtering the logs by that id alone yields a complete, ordered record of every pipeline stage that ran for it — and that a second lesson generated concurrently does not bleed into that record.

**Acceptance Scenarios**:

1. **Given** a lesson was generated successfully, **When** an engineer filters logs by that lesson's id, **Then** they see an ordered entry for each pipeline stage (parse/classify, coverage plan, draft, expressive pass, coverage validation, audio render, completion) with the relevant outcome of each.
2. **Given** two lessons are generated at the same time, **When** an engineer filters by one lesson's id, **Then** only that lesson's entries appear, with no interleaved entries from the other.
3. **Given** a produced lesson, **When** an engineer inspects its log trail, **Then** they can recover the inputs, the model/version, and the prompt version that produced it (reproducibility).

---

### User Story 2 - Pinpoint where and why a generation failed (Priority: P2)

When a lesson ends in a failed state (or is stuck), an engineer needs to see the lifecycle transitions (`pending → generating → ready | failed`) and, for a failure, the stage at which it broke and the reason — from the logs alone, without reproducing the run.

**Why this priority**: Failure diagnosis is the highest-frequency debugging need and depends on the P1 correlation trail, but adds the specific lifecycle + failure-reason visibility that turns "something broke" into "X broke at stage Y because Z."

**Independent Test**: Force a generation failure (e.g., a provider error) and confirm the logs show the status transition into `failed`, the stage that was executing, and a failure reason — all tied to the lesson id.

**Acceptance Scenarios**:

1. **Given** a lesson moves through its lifecycle, **When** each status transition occurs, **Then** a log entry records the previous and new status tied to the lesson id.
2. **Given** a generation fails mid-pipeline, **When** an engineer reads the logs, **Then** they can identify the failing stage and a human-readable failure reason without re-running generation.
3. **Given** a failed lesson is retried, **When** the retry runs, **Then** its transitions are logged and distinguishable from the original attempt.

---

### User Story 3 - Diagnose low quality and performance from decision + timing detail (Priority: P3)

An engineer investigating a *low-quality* (not failed) lesson, or a slow one, needs the substance of each decision: which items were accepted vs. skipped as unteachable and why, which items were uncovered and re-prompted during coverage validation, and how long each audio batch took to render.

**Why this priority**: This is the depth tier — it makes quality and performance regressions diagnosable, but it is only useful once the P1 trail and P2 lifecycle exist to hang the detail on.

**Independent Test**: Generate a lesson from mixed valid/unteachable input and confirm the logs report each item's classification decision and reason, any coverage re-prompts, and a timing for each TTS batch.

**Acceptance Scenarios**:

1. **Given** input containing teachable and unteachable items, **When** classification runs, **Then** logs record, per item, the decision (accepted/skipped), the determined type, and the skip reason where applicable.
2. **Given** the first draft leaves some items uncovered, **When** coverage validation runs, **Then** logs record which items were uncovered and that a re-prompt/correction occurred.
3. **Given** audio is rendered in batches, **When** rendering completes, **Then** logs record a duration for each batch and the total render time.

---

### Edge Cases

- **Logging itself fails** (e.g., serialization error, output stream unavailable): generation MUST continue unaffected — observability is never allowed to break the product path.
- **No lesson id yet**: events that occur before a lesson id exists (e.g., very early input validation) MUST still be logged and clearly marked as un-correlated rather than silently dropped or attributed to the wrong lesson.
- **Secret-bearing payloads**: provider requests/responses and config may contain API keys/tokens; these MUST be redacted before they ever reach a log entry.
- **Very large input**: a big item list MUST NOT produce unbounded or log-flooding output that obscures the trail (volume must stay proportionate and summarizable).
- **High concurrency**: many lessons generating at once MUST remain separable by correlation id with no cross-contamination.
- **Verbose-only detail in production**: deep per-item/per-prompt detail MUST be suppressible so normal operation is not drowned in noise, while still being retrievable when needed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST emit structured, machine-parseable log entries (one self-contained record per event) for each major internal generation stage, in addition to existing HTTP/request-edge logging.
- **FR-002**: Every entry produced during work on a specific lesson MUST carry that lesson's id as a correlation field, so all of a lesson's entries can be retrieved by id alone.
- **FR-003**: Each entry MUST carry a severity level (at minimum: debug, info, warn, error) so consumers can filter by importance.
- **FR-004**: Each entry MUST carry a consistent core shape: timestamp, level, a stable stage/event identifier, the lesson correlation id (or an explicit "none" marker), a human-readable message, and a structured field set.
- **FR-005**: The system MUST log generation lifecycle status transitions (`pending → generating → ready | failed`) with both the previous and new status.
- **FR-006**: On generation failure, the system MUST log the failing stage and a human-readable failure reason tied to the lesson id.
- **FR-007**: The system MUST log teachability classification results per item: the accept/skip decision, the determined item type, and the skip reason when skipped.
- **FR-008**: The system MUST log coverage validation activity: which accepted items were uncovered after drafting and that a re-prompt/correction occurred to cover them.
- **FR-009**: The system MUST log audio render timings: a duration for each render batch and the total stitched render duration.
- **FR-010**: The system MUST log workflow step boundaries (each generation step's start and completion outcome) so the ordered progression through the pipeline is visible.
- **FR-011**: For each produced lesson, the logs MUST make the reproducibility inputs recoverable: the submitted input, the model/version, and the prompt version used (Constitution III).
- **FR-012**: The system MUST redact secrets (provider API keys, tokens, signed credentials) from all log output; no secret may appear in any entry.
- **FR-013**: The active log level MUST be configurable (e.g., quieter in normal operation, verbose for debugging) without code changes, and deep per-item / per-prompt detail MUST be confined to the verbose level.
- **FR-014**: Logging failures MUST be isolated: an error while logging MUST NOT abort, alter, or slow the generation it is observing beyond negligible overhead.
- **FR-015**: Concurrent lessons' entries MUST remain unambiguously separable by correlation id, with no interleaving that misattributes one lesson's events to another.
- **FR-016**: Log entries MUST be emitted to a standard output stream consumable by the host runtime (no dependency on an external logging vendor or shipping pipeline).
- **FR-017**: Learner-submitted content MAY appear in entries only where needed to diagnose quality and MUST NOT appear at the default (non-verbose) level beyond item counts/identifiers; full item text is confined to the verbose level (privacy-conscious, Constitution V).

### Key Entities *(include if feature involves data)*

- **Log Entry**: A single structured, self-contained record of one internal event. Core attributes: timestamp, severity level, stage/event identifier, lesson correlation id (or explicit "none"), message, and a structured field set. Redacted of secrets before emission.
- **Pipeline Stage / Event**: The named unit of work an entry describes (e.g., input parsing, teachability classification, coverage planning, draft, expressive pass, coverage validation, audio batch render, status transition, completion/failure). Provides the stable taxonomy used for filtering.
- **Correlation Id**: The lesson id that ties together all entries for one generation run, enabling end-to-end per-lesson retrieval and concurrency separation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any produced lesson, 100% of the pipeline stages that executed for it are retrievable by filtering on that lesson's id alone.
- **SC-002**: For a failed lesson, an engineer can identify the failing stage and the failure reason from logs alone — without re-running generation — in under 5 minutes.
- **SC-003**: Zero secrets appear in log output, verified by an automated scan of emitted entries against known secret patterns.
- **SC-004**: 100% of lesson lifecycle status transitions appear in the logs with previous and new status.
- **SC-005**: 100% of audio render batches have a recorded timing, and every lesson has a total render duration entry.
- **SC-006**: Enabling structured logging adds no generation failures and negligible overhead to generation wall-clock time (no perceptible regression in the existing generation flow).
- **SC-007**: When N lessons generate concurrently, each lesson's id-filtered trail contains only its own entries (0% cross-attribution).
- **SC-008**: For any produced lesson, the inputs, model/version, and prompt version are recoverable from its log trail (reproducibility).

## Assumptions

- The audience for these logs is engineers/operators; this feature adds no learner-facing UI or behavior.
- Existing HTTP/request-edge logging remains; this feature extends observability *inward* into the generation pipeline, it does not replace edge logging.
- Log output is written to the process's standard output stream and consumed by whatever runs the process; collecting, storing, shipping, or visualizing logs in an external system is out of scope (see below).
- Structured entries are line-oriented JSON suitable for `grep`/`jq`-style filtering by correlation id and level.
- Default operating level is concise (info and above); verbose (debug) is opt-in for active debugging.
- Learner-submitted vocabulary items are the learner's own study material and may be shown at the verbose level for quality debugging; emails/identities/secrets are never logged.
- The pipeline stages to instrument are the existing ones: input parse/classify (teachability), coverage planning, draft, expressive pass, coverage validation, audio batch render/stitch, and the generation bridge/runner status transitions.

## Out of Scope

- Any third-party APM vendor, log-shipping pipeline, or log-storage/visualization infrastructure.
- LangSmith eval-trace export (already covered by the S1 task T052 / `tracing.ts`).
- Changes to the learner-facing UI, lesson content, or generation quality itself (this feature observes; it does not alter generation behavior).
- Metrics/alerting/dashboards built on top of the logs.

## Dependencies

- Builds on the implemented S1 `lesson-generation` feature (the generator workflow, the generation bridge/runner with its status transitions, teachability, coverage validation, and the TTS render path are the surfaces being instrumented).
