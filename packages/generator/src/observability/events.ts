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
  | "generate.result" // success summary (itemCount, modelId, promptVersion, segments, coverage)
  | "generate.error" // failure (stage, reason)
  // Adaptive live story (006-adaptive-live-story). Emitted by the web app, sharing this
  // vocabulary + the injected Logger port (003-internal-logging). Coverage and length,
  // formerly validated at generation time, are observed HERE at narration time (R3/R8).
  | "story.session" // live-story session lifecycle (opened session, minted token, ended)
  | "story.beat" // a narrated beat / advanceNarration step (beatIndex, owed items)
  | "story.coverage" // coverage progress (covered/total; conclude allowed/blocked)
  | "story.scenario" // a scenario change pinned for the rest of the session (latest wins)
  | "story.turn" // a captured/persisted session turn (role, kind, turnIndex; text @debug)
  | "story.error" // live-story session / persistence failure
  | "story.unavailable"; // live story not configured/reachable; fallback surfaced (FR-026)
