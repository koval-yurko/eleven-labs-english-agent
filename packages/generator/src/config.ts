/**
 * Generator configuration (research R1/R3/R4). Voice IDs and tuning come from the
 * environment; the teacher voice is FIXED and reused by the live tutor (Constitution I).
 */

export interface GeneratorConfig {
  teacherVoiceId: string;
  learnerVoiceId: string;
  /** Hard ceiling on teachable items per lesson (research R1). */
  maxTeachableItems: number;
  /** Length bound target window in seconds (FR-012, research R3). */
  targetMinSeconds: number;
  targetMaxSeconds: number;
  /** Speaking rate used to budget script length (research R3). */
  wordsPerMinute: number;
  /** ElevenLabs per-request character ceiling for Text to Dialogue (research R5). */
  ttsCharLimit: number;
}

export const DEFAULT_MAX_TEACHABLE_ITEMS = 20;

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return parsed;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return raw;
}

export function loadGeneratorConfig(env: NodeJS.ProcessEnv = process.env): GeneratorConfig {
  return {
    teacherVoiceId: required(env, "ELEVENLABS_TEACHER_VOICE_ID"),
    learnerVoiceId: required(env, "ELEVENLABS_LEARNER_VOICE_ID"),
    maxTeachableItems: intFromEnv(env, "MAX_TEACHABLE_ITEMS", DEFAULT_MAX_TEACHABLE_ITEMS),
    targetMinSeconds: intFromEnv(env, "TARGET_MIN_SECONDS", 300),
    targetMaxSeconds: intFromEnv(env, "TARGET_MAX_SECONDS", 600),
    wordsPerMinute: intFromEnv(env, "GENERATION_WPM", 150),
    ttsCharLimit: intFromEnv(env, "TTS_CHAR_LIMIT", 3000),
  };
}
