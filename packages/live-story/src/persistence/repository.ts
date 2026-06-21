import type { SessionTurnKind, SessionTurnRole } from "@idiomatic/contracts";

/**
 * Persistence boundary for the adaptive live-story transcript (006-adaptive-live-story).
 * Owner-scoped throughout — a learner can only ever read/write their own sessions and
 * turns (FR-028), enforced in code here and by RLS (0005_live_story.sql) as defense in
 * depth. Turns are appended incrementally as `onMessage`/correction fire (off the speech
 * path) so a dropped/abandoned session keeps its partial record (FR-027).
 *
 * The single permitted mutation of an existing turn is the **barge-in correction**: a
 * teacher turn carrying an `elevenTurnRef` that matches an already-persisted teacher turn
 * has its text overwritten IN PLACE (R5/R6) rather than appended — so caption and
 * transcript never diverge and never show cut-off text (FR-020/FR-022).
 */

export interface SessionTurnRecord {
  role: SessionTurnRole;
  kind: SessionTurnKind;
  text: string;
  turnIndex: number;
  elevenTurnRef: string | null;
}

export interface LiveSessionRecord {
  id: string;
  lessonId: string;
  ownerId: string;
  status: "active" | "ended";
  scenario: string | null;
  elevenlabsConversationId: string | null;
  createdAt: string;
  endedAt: string | null;
  turns: SessionTurnRecord[];
}

export interface OpenSessionInput {
  lessonId: string;
  ownerId: string;
  /** Initial scenario; null = the plan's original setting. */
  scenario: string | null;
}

export interface AppendTurnInput {
  role: SessionTurnRole;
  kind: SessionTurnKind;
  text: string;
  /** When present and it matches an existing teacher turn, that turn is upserted in place. */
  elevenTurnRef: string | null;
}

export interface LiveStoryRepository {
  /** Open a new `active` session for a lesson (stamped with ownerId). Returns the row. */
  openSession(input: OpenSessionInput): Promise<LiveSessionRecord>;

  /** Owner-scoped fetch of a single session + its ordered turns; null if missing/not owned. */
  getSession(ownerId: string, sessionId: string): Promise<LiveSessionRecord | null>;

  /**
   * Append finalized turns (assigning the next `turnIndex` per turn). A teacher turn whose
   * `elevenTurnRef` matches an existing turn is updated in place (barge-in correction).
   * Returns the updated session with all turns so far.
   */
  appendTurns(
    ownerId: string,
    sessionId: string,
    turns: AppendTurnInput[],
  ): Promise<LiveSessionRecord>;

  /** Overwrite the session's current scenario (latest wins, FR-009). */
  updateScenario(ownerId: string, sessionId: string, scenario: string | null): Promise<void>;

  /** Mark the session ended (status=ended, ended_at=now). */
  endSession(ownerId: string, sessionId: string): Promise<void>;

  /** Persist the realtime conversation id once (reproducibility, Constitution III). */
  setConversationId(ownerId: string, sessionId: string, conversationId: string): Promise<void>;

  /** Owner-scoped list of a lesson's sessions, most-recent-first, each with ordered turns. */
  listTranscript(ownerId: string, lessonId: string): Promise<LiveSessionRecord[]>;
}
