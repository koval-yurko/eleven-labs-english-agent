/**
 * The contracts the package defines but expects the host (the web app) to provide:
 * the injectable `Clock`/`IdGenerator`, the narrow read port over the lesson store
 * (`LessonReader`), and the server-side config shape (`LiveStoryConfig`). Keeping them in
 * one file makes the "what the app must wire in" surface easy to see at a glance.
 *
 * The transcript persistence contract (`LiveStoryRepository`) lives with its in-memory impl
 * in `persistence/` instead, since the two are read and changed together.
 */
import type { LessonScript } from "@idiomatic/contracts";
import type { PlanSourceItem } from "@idiomatic/generator";

/** Injectable clock so timestamps are deterministic in tests. */
export interface Clock {
  now(): Date;
}

/** Injectable id source so generated ids are deterministic in tests. */
export interface IdGenerator {
  next(): string;
}

/** The slice of a lesson the live-story services read. */
export interface LessonView {
  status: string;
  script: LessonScript | null;
}

/**
 * Narrow, owner-scoped read port the live-story services need from the lesson store. The
 * package depends on this minimal shape — NOT the web app's full `LessonRepository` — so the
 * boundary stays one-directional (app → package). The web app's repository structurally
 * satisfies it (its richer `LessonRecord`/`SourceItemRecord` are assignable here).
 */
export interface LessonReader {
  /** Owner-scoped fetch; null if missing OR not owned (no existence leak). */
  getLesson(ownerId: string, id: string): Promise<LessonView | null>;

  /** Owner-scoped source items, ordered — the minimal shape `derivePlan` consumes. */
  getSourceItems(ownerId: string, lessonId: string): Promise<PlanSourceItem[]>;
}

/**
 * Server-side configuration for the live story: the dedicated narrator agent
 * (`ELEVENLABS_STORY_AGENT_ID`), the ElevenLabs key, and the target-length clamp window the
 * plan derivation uses. The api key is consumed only by `StartStoryService` (the mint) and
 * NEVER returned to the browser (Constitution V). The env reader that produces this lives in
 * the web app so the package never touches `process.env`.
 */
export interface LiveStoryConfig {
  apiKey?: string;
  agentId?: string;
  targetMinSeconds: number;
  targetMaxSeconds: number;
}
