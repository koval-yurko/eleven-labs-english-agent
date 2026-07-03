/**
 * Client-safe tutor session constants and types, shared by the browser tutor component,
 * the lesson data layer, and the post-call webhook. No server imports here.
 */

/** One turn of a tutor conversation as stored in lesson_sessions.transcript. */
export interface TranscriptLine {
  role: "user" | "agent";
  text: string;
  timeInCallSecs?: number;
}

/**
 * Hidden message the browser sends the instant the session connects, so the agent greets
 * and starts teaching ON ITS OWN — the learner never has to speak first (an empty
 * first_message makes the agent wait; a user message reliably triggers its opening turn).
 * Both the live transcript UI and the stored history filter it out, so the record reads
 * as the teacher speaking first.
 */
export const KICKOFF_MESSAGE =
  "Let's begin. Greet me in one sentence and start teaching the first item now.";
