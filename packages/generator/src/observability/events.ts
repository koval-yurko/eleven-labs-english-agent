/**
 * Stable stage/event identifiers for the generation pipeline (research R8, 003-internal-logging).
 *
 * These are the filtering vocabulary for the structured log trail: every emitted entry
 * carries one `EventId` so an engineer can `grep`/`jq` for a stage across a lesson's run.
 * The set is intentionally small and stable — adding a stage means adding a member here,
 * never an ad-hoc string at a call site.
 */
export type EventId =
  | "lesson.status" // lifecycle transition (from/to, reason?, stage?)
  | "teachability.item" // per-item accept/skip (+ type; raw text @debug)
  | "teachability.summary" // requested/accepted/skipped counts
  | "generate.draft" // draft attempt (attempt/maxAttempts, outcome?; body @debug)
  | "generate.coverage" // coverage result (ok, uncovered[], reprompted)
  | "render.batch" // per-TTS-batch timing (batchIndex/Count, chars, durationMs)
  | "render.total" // stitched totals (bytes, audioDurationSeconds, renderDurationMs)
  | "generate.result" // success summary (itemCount, modelId, promptVersion, segments, coverage)
  | "generate.error" // failure (stage, reason)
  // Live-tutor Q&A (005-live-tutor-qa). Emitted by the web app, not the batch pipeline,
  // but they share this vocabulary + the injected Logger port (003-internal-logging).
  | "qa.session" // live session lifecycle (minted token, connectionType; availability)
  | "qa.turn" // a captured exchange turn (role, turnIndex; text @debug only)
  | "qa.exchange" // a persisted exchange (exchangeIndex, sourceItemId, turnCount, position)
  | "qa.unavailable" // live tutor not configured/reachable; fallback surfaced (FR-017)
  | "qa.error"; // live session / persistence failure
