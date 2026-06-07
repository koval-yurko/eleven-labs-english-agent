import type { Level } from "./observability";

/**
 * Generator configuration (research R1/R3/R4). Voice IDs and tuning come from the
 * environment; the teacher voice is FIXED and reused by the live tutor (Constitution I).
 */

export interface GeneratorConfig {
  teacherVoiceId: string;
  learnerVoiceId: string;
  /** Hard ceiling on teachable items per lesson (research R1). */
  maxTeachableItems: number;
  /** Length bound target window in seconds used to budget script length (research R3). */
  targetMinSeconds: number;
  targetMaxSeconds: number;
  /** Speaking rate used to budget script length (research R3). */
  wordsPerMinute: number;
  /** Claude model id for generation (Constitution III reproducibility). */
  modelId: string;
  /** Minimum structured-log level emitted (003-internal-logging). Default `info`. */
  logLevel?: Level;
  /** When true, emit human-readable log lines instead of raw NDJSON (dev only). */
  logPretty?: boolean;
}

export const DEFAULT_MAX_TEACHABLE_ITEMS = 20;

const LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/** Parse `LOG_LEVEL` from the environment, defaulting to `info` on absent/invalid. */
export function parseLogLevel(raw: string | undefined): Level {
  const value = raw?.trim().toLowerCase();
  return value && LOG_LEVELS.has(value) ? (value as Level) : "info";
}

/** Truthy `LOG_PRETTY` flag (`1`/`true`/`yes`). */
export function parseLogPretty(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

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
    modelId: env.GENERATION_MODEL_ID?.trim() || "claude-opus-4-8",
    logLevel: parseLogLevel(env.LOG_LEVEL),
    logPretty: parseLogPretty(env.LOG_PRETTY),
  };
}
