# Feature Specification: Parallelize Batch TTS Rendering

**Feature Branch**: `004-tts-parallel-render`
**Created**: 2026-06-07
**Status**: Draft
**Input**: User description: "Parallelize batch TTS rendering with a bounded-concurrency pool to cut lesson generation wall-clock time. Render per-batch ElevenLabs Text-to-Dialogue calls concurrently with a configurable cap set under the ElevenLabs plan concurrency limit, preserve stitch order, extract a reusable mapWithConcurrency utility, and add a generation-can-take-a-few-minutes note in the UI."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Faster lesson generation for multi-batch lessons (Priority: P1)

A learner submits a real-sized list (5–10 items) and waits for the system to produce
the audio lesson. Today the audio render walks each segment batch one after another, so
a lesson that splits into several batches waits for each batch's synthesis to finish
before the next one starts; the total wait grows roughly linearly with lesson length.
With bounded-parallel rendering, multiple batches synthesize at the same time, so the
learner gets a ready lesson in a fraction of the previous wait.

**Why this priority**: Audio synthesis dominates generation wall-clock time and is the
single biggest lever on perceived latency for the core lesson-generation experience.
This is the entire value of the enhancement; everything else supports it.

**Independent Test**: Generate a lesson whose script splits into multiple batches and
confirm the resulting lesson is identical in content/ordering to a sequentially-rendered
one, while measured render wall-clock time is materially lower (approaching
`sequential_time ÷ concurrency` for the batch count involved).

**Acceptance Scenarios**:

1. **Given** a lesson script that splits into N batches (N > 1), **When** the audio is
   rendered, **Then** up to the configured concurrency limit of batches are synthesized
   concurrently and the lesson reaches `ready` faster than the equivalent sequential render.
2. **Given** a multi-batch lesson rendered in parallel, **When** the audio segments are
   stitched, **Then** the final audio plays the batches in their original script order,
   byte-for-byte equivalent to a sequential render of the same script.
3. **Given** a single-batch lesson, **When** it is rendered, **Then** behavior and output
   are unchanged from today (no regression for tiny inputs).

---

### User Story 2 - Generation stays within provider concurrency limits (Priority: P1)

The operator runs the system on an ElevenLabs plan that caps how many synthesis requests
may be in flight at once. Parallel rendering must never exceed that cap, otherwise the
provider returns rate-limit errors (HTTP 429) and lessons fail. The operator sets the
concurrency cap via configuration so it can be tuned to whatever plan is in effect.

**Why this priority**: Uncapped parallelism would trade a latency win for a reliability
regression (failed lessons). The bound is not optional polish — it is a core correctness
constraint of the feature.

**Independent Test**: Set the concurrency cap to K and render a lesson with more than K
batches; confirm no more than K batch renders are ever in flight simultaneously and the
lesson completes without rate-limit failures.

**Acceptance Scenarios**:

1. **Given** a configured concurrency cap of K, **When** a lesson with more than K batches
   renders, **Then** at no point are more than K batch syntheses in flight at once.
2. **Given** no concurrency value is configured, **When** a lesson renders, **Then** a safe
   conservative default cap (below typical plan limits) is applied automatically.
3. **Given** one batch in a multi-batch render fails, **When** rendering completes, **Then**
   the whole lesson generation fails clearly (as it would today) rather than producing a
   silently incomplete or mis-ordered audio file.

---

### User Story 3 - Reusable bounded-concurrency primitive (Priority: P2)

A developer needs to run a collection of async tasks with a ceiling on how many run at
once, preserving result order. The bounded-parallel logic used for TTS batches is extracted
into a single reusable utility so future work (e.g. parallel item classification, bulk
regeneration) can reuse it instead of re-implementing concurrency control.

**Why this priority**: The concurrency primitive is reused beyond TTS per the backlog note,
but the lesson-latency win (Stories 1–2) delivers value even if the utility were inlined.
Extraction is high-value maintainability, not a blocker for the user-facing gain.

**Independent Test**: Call the utility with a list of tasks, a mapper, and a concurrency
limit; confirm results come back in input order, never more than the limit run at once,
and a task failure surfaces as a rejected outcome without silently dropping results.

**Acceptance Scenarios**:

1. **Given** a list of items, a concurrency limit K, and an async mapper, **When** the
   utility runs, **Then** results are returned in the same order as the input list.
2. **Given** a concurrency limit K and more than K items, **When** the utility runs, **Then**
   no more than K mapper invocations are in flight at any instant.
3. **Given** a mapper that rejects for one item, **When** the utility runs, **Then** the
   failure is propagated (not swallowed) so the caller can fail the operation.

---

### User Story 4 - Learner knows the wait is expected (Priority: P3)

A learner submits a list and sees a clear note that generation can take a few minutes, so
the multi-minute wait reads as normal progress rather than a stuck or broken page.

**Why this priority**: Pure expectation-setting. It improves perceived experience but does
not change generation behavior; the latency improvement itself is the substantive win.

**Independent Test**: Submit a lesson and confirm the in-progress UI communicates that
generation can take a few minutes while the lesson is in a non-terminal state.

**Acceptance Scenarios**:

1. **Given** a lesson is generating, **When** the learner views the lesson while it is in a
   non-terminal state, **Then** the UI shows a note that generation can take a few minutes.
2. **Given** the lesson reaches `ready` or `failed`, **When** the learner views it, **Then**
   the "can take a few minutes" note is no longer shown.

---

### Edge Cases

- **Single batch**: A lesson that fits in one batch renders exactly as today; parallelism
  has no effect and adds no overhead.
- **Batch count below the cap**: When there are fewer batches than the concurrency limit,
  all batches run at once and the cap is simply never reached.
- **Partial failure**: If any batch synthesis fails (including provider rate-limit/429),
  the overall lesson generation fails with a clear status; no partial or out-of-order audio
  is persisted.
- **Misconfigured cap**: A cap of zero, negative, or non-numeric falls back to the safe
  default rather than disabling rendering or running unbounded.
- **Cap of 1**: Setting the cap to 1 reproduces today's fully-sequential behavior (useful as
  a safety/rollback switch).
- **Order under varying completion times**: Batches that finish out of order (a later batch
  synthesizes faster) must still be stitched in original script order.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST render a lesson's per-batch Text-to-Dialogue syntheses
  concurrently rather than strictly one-after-another.
- **FR-002**: The system MUST enforce a configurable upper bound on the number of batch
  syntheses in flight simultaneously, and MUST never exceed that bound.
- **FR-003**: The concurrency bound MUST be configurable via environment/runtime
  configuration, with a safe conservative default applied when unset or invalid.
- **FR-004**: The default and operator-set bound MUST be settable below the active provider
  plan's concurrency limit so that rate-limit (429) failures are avoided under normal load.
- **FR-005**: The system MUST preserve original script/batch order in the stitched audio
  regardless of the order in which individual batch syntheses complete.
- **FR-006**: The stitched audio output for any given script MUST be equivalent to the
  output produced by the prior sequential renderer (no content, ordering, or duration change).
- **FR-007**: If any batch synthesis fails, the system MUST fail the overall lesson
  generation clearly and MUST NOT persist a partial or mis-ordered audio result.
- **FR-008**: The bounded-concurrency behavior MUST be implemented as a single reusable
  utility that maps a list of items through an async function with a concurrency ceiling and
  order-preserving results, so it can be reused beyond TTS.
- **FR-009**: The reusable utility MUST return results in input order and MUST propagate (not
  swallow) a task failure to the caller.
- **FR-010**: Per-batch progress/observability (e.g. existing batch render log events) MUST
  continue to be emitted for each batch when rendering in parallel.
- **FR-011**: The in-progress lesson UI MUST inform the learner that generation can take a
  few minutes while the lesson is in a non-terminal state, and stop showing it once the
  lesson is terminal.
- **FR-012**: Single-batch lessons MUST behave identically to today, with no added latency or
  behavioral change from the concurrency machinery.

### Key Entities *(include if feature involves data)*

- **Batch**: A group of dialogue segments rendered in one synthesis request, sized under a
  character limit. Has an inherent position in the lesson script that fixes its place in the
  final stitched audio.
- **Concurrency bound**: A configured maximum number of batch syntheses allowed in flight at
  once; derived from configuration with a safe default, intended to sit below the provider
  plan limit.
- **Rendered audio**: The single stitched audio artifact for a lesson, assembled from batch
  outputs in script order, unchanged in shape from today (audio bytes + mime type + duration).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a lesson that splits into N batches (N > 1), end-to-end audio render
  wall-clock time is reduced toward `sequential_render_time ÷ min(N, concurrency_bound)`,
  with a measurable reduction of at least 40% for a typical 5–10 item lesson versus the
  current sequential render.
- **SC-002**: Across repeated multi-batch generations at the configured bound, zero lessons
  fail due to provider rate-limiting (429) under normal operating load.
- **SC-003**: 100% of generated lessons play their content in correct script order, identical
  to sequential rendering, across single-batch and multi-batch cases.
- **SC-004**: Single-batch lessons show no measurable latency regression versus today.
- **SC-005**: Learners viewing an in-progress lesson see clear messaging that generation can
  take a few minutes, so the wait is understood as expected (no increase in
  abandon-because-looks-stuck behavior).

## Assumptions

- **Default concurrency bound**: When unset, the system applies a conservative default
  (assumed small, e.g. around 3) chosen to stay safely under common ElevenLabs plan
  concurrency limits. Operators raise it to match their plan.
- **Batch splitting unchanged**: How a script is split into batches (character-limit-based
  grouping) is unchanged by this feature; only the rendering of those batches is parallelized.
- **Failure semantics unchanged**: A failed batch fails the whole lesson, exactly as a failed
  sequential batch does today; this feature does not add per-batch retry or partial-success
  behavior.
- **Provider path scope**: This applies only to the batched Text-to-Dialogue render path;
  the realtime live-tutor streaming path is out of scope and unaffected.
- **Observability preserved**: Existing structured logging (per-batch timings, lesson status
  transitions) remains in place; parallel rendering may interleave batch log entries.

## Out of Scope

- Progressive / streaming playback (starting playback of batch 1 while batch 2 still renders).
  A larger latency win but a much larger change — deferred.
- The realtime live-tutor (S2) path, which uses a different streaming API; this enhancement
  does not apply there.
- Per-batch retry, backoff, or partial-success recovery semantics.
- Changes to batch splitting/sizing logic.
- Adopting a third-party concurrency library when a small in-repo primitive suffices.

## Dependencies

- Builds on the existing S1 lesson-generation feature (the batched Text-to-Dialogue render
  and the lesson status lifecycle it owns).
