import { z } from "zod";

/**
 * Lesson / SourceItem / status DTOs shared across the generator and the web app.
 * Derived from data-model.md.
 */

/** Lesson lifecycle (research R6 / data-model state machine). */
export const LESSON_STATUSES = ["pending", "generating", "ready", "failed"] as const;
export const LessonStatus = z.enum(LESSON_STATUSES);
export type LessonStatus = z.infer<typeof LessonStatus>;

export const ITEM_TYPES = ["word", "sentence", "idiom"] as const;
export const ItemType = z.enum(ITEM_TYPES);
export type ItemType = z.infer<typeof ItemType>;

/** Why a submitted entry was not turned into a teachable item (research R9). */
export const SKIP_REASONS = ["non_english", "gibberish", "not_discrete", "duplicate"] as const;
export const SkipReason = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReason>;

/** A single submitted unit and its teachability outcome (FR-001..FR-003, FR-006). */
export const SourceItem = z.object({
  id: z.string(),
  rawText: z.string(),
  normalizedText: z.string(),
  itemType: ItemType,
  teachable: z.boolean(),
  skipReason: SkipReason.nullable(),
  orderIndex: z.number().int().min(0),
  covered: z.boolean(),
});
export type SourceItem = z.infer<typeof SourceItem>;

/** Per-entry skip report surfaced on submit and in lesson detail (FR-006, Story 3.4). */
export const SkippedEntry = z.object({
  rawText: z.string(),
  reason: SkipReason,
});
export type SkippedEntry = z.infer<typeof SkippedEntry>;

/** Compact status payload returned by the submit/retry endpoints (contracts/http-api.md). */
export const LessonStatusDTO = z.object({
  id: z.string(),
  status: LessonStatus,
  acceptedItemCount: z.number().int().min(0),
  skipped: z.array(SkippedEntry),
  errorReason: z.string().nullable(),
  createdAt: z.string(),
});
export type LessonStatusDTO = z.infer<typeof LessonStatusDTO>;

/** A row in the lesson library list (FR-020). */
export const LessonSummary = z.object({
  id: z.string(),
  status: LessonStatus,
  itemPreview: z.array(z.string()),
  acceptedItemCount: z.number().int().min(0),
  createdAt: z.string(),
});
export type LessonSummary = z.infer<typeof LessonSummary>;

/** Submit request body (contracts/http-api.md POST /api/lessons). */
export const CreateLessonRequest = z.object({
  /** Either an array of entries or a single newline-delimited string the server splits. */
  items: z.union([z.array(z.string()), z.string()]),
});
export type CreateLessonRequest = z.infer<typeof CreateLessonRequest>;

/** Standard error envelope (contracts/http-api.md). */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
