import {
  ClaudeLlmAdapter,
  JsonLogger,
  MockLlmAdapter,
  parseLogLevel,
  parseLogPretty,
  type GenerateLessonDeps,
  type GeneratorConfig,
  type LlmAdapter,
  type Logger,
} from "@idiomatic/generator";

/**
 * Builds the generator config + LLM adapter. The real Claude adapter is used when its API
 * key is present; otherwise a deterministic mock so the app runs locally and CI runs without
 * live keys (Constitution Dev Workflow). Generation is script-only — no audio render (007).
 */
export function buildGeneratorConfig(
  env: Record<string, string | undefined> = process.env,
): GeneratorConfig {
  const int = (key: string, fallback: number): number => {
    const raw = env[key];
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isNaN(n) ? fallback : n;
  };
  return {
    teacherVoiceId: env.ELEVENLABS_TEACHER_VOICE_ID ?? "mock-teacher-voice",
    learnerVoiceId: env.ELEVENLABS_LEARNER_VOICE_ID ?? "mock-learner-voice",
    maxTeachableItems: int("MAX_TEACHABLE_ITEMS", 20),
    targetMinSeconds: int("TARGET_MIN_SECONDS", 300),
    targetMaxSeconds: int("TARGET_MAX_SECONDS", 600),
    wordsPerMinute: int("GENERATION_WPM", 150),
    modelId: env.GENERATION_MODEL_ID?.trim() || "claude-opus-4-8",
    logLevel: parseLogLevel(env.LOG_LEVEL),
    logPretty: parseLogPretty(env.LOG_PRETTY),
  };
}

/** True when the generation provider (Claude) is configured to run for real. */
export function hasGenerationKeys(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Build the process root logger from the environment (003-internal-logging). NDJSON to
 * stdout, honoring `LOG_LEVEL`/`LOG_PRETTY`. The web generation bridge derives per-run
 * child loggers bound to `{ lessonId, ownerId }` from this root for correlation.
 */
export function createLogger(env: Record<string, string | undefined> = process.env): Logger {
  return new JsonLogger({
    level: parseLogLevel(env.LOG_LEVEL),
    pretty: parseLogPretty(env.LOG_PRETTY),
  });
}

export function buildGenerateLessonDeps(
  env: Record<string, string | undefined> = process.env,
): GenerateLessonDeps {
  const config = buildGeneratorConfig(env);

  const llm: LlmAdapter = hasGenerationKeys(env)
    ? new ClaudeLlmAdapter(env.ANTHROPIC_API_KEY!, config.modelId)
    : new MockLlmAdapter();

  return { llm, config };
}
