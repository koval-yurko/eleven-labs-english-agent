import {
  ClaudeLlmAdapter,
  ElevenLabsTtsAdapter,
  MockLlmAdapter,
  MockTtsAdapter,
  type GenerateLessonDeps,
  type GeneratorConfig,
  type LlmAdapter,
  type TtsAdapter,
} from "@idiomatic/generator";

/**
 * Builds the generator config + adapter set. Real Claude + ElevenLabs adapters are used
 * when their API keys are present; otherwise deterministic mocks so the app runs locally
 * and CI runs without live keys (Constitution Dev Workflow).
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
    ttsCharLimit: int("TTS_CHAR_LIMIT", 3000),
    modelId: env.GENERATION_MODEL_ID?.trim() || "claude-opus-4-8",
    ttsModelId: env.ELEVENLABS_MODEL_ID?.trim() || "eleven_v3",
    ttsBitrate: int("ELEVENLABS_BITRATE", 128000),
  };
}

/** True when both generation providers are configured to run for real. */
export function hasGenerationKeys(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.ELEVENLABS_API_KEY);
}

export function buildGenerateLessonDeps(
  env: Record<string, string | undefined> = process.env,
): GenerateLessonDeps {
  const config = buildGeneratorConfig(env);

  let llm: LlmAdapter;
  let tts: TtsAdapter;
  if (hasGenerationKeys(env)) {
    llm = new ClaudeLlmAdapter(env.ANTHROPIC_API_KEY!, config.modelId);
    tts = new ElevenLabsTtsAdapter(env.ELEVENLABS_API_KEY!, {
      modelId: config.ttsModelId,
      bitrate: config.ttsBitrate,
      teacherVoiceId: config.teacherVoiceId,
      learnerVoiceId: config.learnerVoiceId,
    });
  } else {
    llm = new MockLlmAdapter();
    tts = new MockTtsAdapter(config.wordsPerMinute);
  }

  return { llm, tts, config };
}
