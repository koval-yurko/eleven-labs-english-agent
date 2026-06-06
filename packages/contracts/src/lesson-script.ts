import { z } from "zod";

/**
 * LessonScript — the structured two-voice podcast script.
 *
 * This is the BOUNDARY ARTIFACT between the Lesson Generator (batch) and the
 * Player/web app. The two subsystems communicate through this schema, not shared
 * internal state (Constitution: subsystem independence). Mirrors
 * contracts/lesson-script.schema.json and is stored as `lessons.script` (jsonb).
 */

export const SPEAKER_ROLES = ["learner", "teacher"] as const;
export const SpeakerRole = z.enum(SPEAKER_ROLES);
export type SpeakerRole = z.infer<typeof SpeakerRole>;

export const Speaker = z.object({
  role: SpeakerRole,
  /** ElevenLabs voice ID. Teacher voiceId is fixed across scripted + live (Constitution I). */
  voiceId: z.string().min(1),
  displayName: z.string().optional(),
});
export type Speaker = z.infer<typeof Speaker>;

export const LessonSegment = z.object({
  /** Stable id referenced by coverage entries. */
  id: z.string().min(1),
  speaker: SpeakerRole,
  /** Spoken line. Per-request render payload must stay under the TTS char limit (research R5). */
  text: z.string().min(1),
  /** Expressiveness cues for Text to Dialogue so output sounds told, not read (Constitution I). */
  audioTags: z.array(z.string()).optional(),
});
export type LessonSegment = z.infer<typeof LessonSegment>;

export const CoverageEntry = z.object({
  /** References a teachable SourceItem.id. */
  sourceItemId: z.string().min(1),
  normalizedText: z.string().min(1),
  /** Segments that teach this item; MUST be non-empty for every accepted item (FR-009). */
  segmentIds: z.array(z.string().min(1)).min(1),
});
export type CoverageEntry = z.infer<typeof CoverageEntry>;

export const LESSON_SCRIPT_VERSION = "1.0" as const;

export const LessonScript = z.object({
  version: z.literal(LESSON_SCRIPT_VERSION),
  speakers: z.object({
    learner: Speaker,
    teacher: Speaker,
  }),
  segments: z.array(LessonSegment).min(1),
  /** Item -> segment map proving every accepted item is taught (FR-009/SC-002; research R2). */
  coverage: z.array(CoverageEntry),
  /** Length budget estimate at script time (~300-600s target, FR-012). */
  estimatedDurationSeconds: z.number().int().min(1),
});
export type LessonScript = z.infer<typeof LessonScript>;
