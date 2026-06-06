import type {
  ItemType,
  LessonScript,
  LessonStatus,
  SkipReason,
} from "@idiomatic/contracts";

/**
 * Internal persistence records (data-model.md). These are the shapes the
 * LessonRepository reads/writes; API DTOs in @idiomatic/contracts are derived from them.
 */

export interface LessonRecord {
  id: string;
  ownerId: string;
  status: LessonStatus;
  requestedItemCount: number;
  acceptedItemCount: number;
  skippedItemCount: number;
  targetDurationSeconds: number;
  audioDurationSeconds: number | null;
  script: LessonScript | null;
  errorReason: string | null;
  modelId: string | null;
  promptVersion: string | null;
  generationInput: { items: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface SourceItemRecord {
  id: string;
  lessonId: string;
  ownerId: string;
  rawText: string;
  normalizedText: string;
  itemType: ItemType;
  teachable: boolean;
  skipReason: SkipReason | null;
  orderIndex: number;
  covered: boolean;
}

export interface LessonAudioRecord {
  id: string;
  lessonId: string;
  ownerId: string;
  storagePath: string;
  mimeType: string;
  durationSeconds: number;
  createdAt: string;
}
