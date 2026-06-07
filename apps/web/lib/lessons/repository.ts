import type { LessonScript } from "@idiomatic/contracts";
import type { LessonRecord, SourceItemRecord } from "./types";

/**
 * Persistence boundary. All reads/writes are OWNER-SCOPED — the repository never
 * exposes a lesson to a non-owner (FR-019, SC-005). The Supabase implementation
 * runs through the RLS-governed client; the in-memory implementation enforces the
 * same scoping so privacy is testable without a database (research R7/R11).
 */

export interface CreatePendingLessonInput {
  ownerId: string;
  generationInput: { items: string[] };
  requestedItemCount: number;
  acceptedItemCount: number;
  skippedItemCount: number;
  targetDurationSeconds: number;
  sourceItems: Omit<SourceItemRecord, "id" | "lessonId" | "ownerId">[];
}

export interface ReadyLessonUpdate {
  script: LessonScript;
  modelId: string;
  promptVersion: string;
  /** Order indexes of source items the script covers; sets their `covered` flag (FR-009). */
  coveredOrderIndexes: number[];
}

export interface LessonRepository {
  /** Create a `pending` lesson + its source items, all stamped with `ownerId` (T026). */
  createPendingLesson(input: CreatePendingLessonInput): Promise<LessonRecord>;

  /** Owner-scoped fetch; returns null if missing OR not owned (no existence leak). */
  getLesson(ownerId: string, id: string): Promise<LessonRecord | null>;

  /** Owner-scoped source items for a lesson, ordered. */
  getSourceItems(ownerId: string, lessonId: string): Promise<SourceItemRecord[]>;

  /** Owner-scoped list, newest first (FR-020). */
  listLessons(ownerId: string): Promise<LessonRecord[]>;

  setStatus(id: string, status: LessonRecord["status"]): Promise<void>;

  /** Mark ready: persist script, metadata, covered flags (T027). A valid script ⇒ ready (FR-004). */
  markReady(id: string, update: ReadyLessonUpdate): Promise<void>;

  markFailed(id: string, errorReason: string): Promise<void>;
}
