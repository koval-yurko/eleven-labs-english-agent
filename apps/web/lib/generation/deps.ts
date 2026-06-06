import {
  MockLlmAdapter,
  MockTtsAdapter,
  type GenerateLessonDeps,
  type GeneratorConfig,
} from "@idiomatic/generator";

/**
 * Builds the generator config + adapter set. Real Claude/Mastra + ElevenLabs adapters
 * plug in here when keys are present; absent keys fall back to deterministic mocks so
 * the app runs locally and CI runs without live keys (Constitution Dev Workflow).
 */
export function buildGeneratorConfig(env: Record<string, string | undefined> = process.env): GeneratorConfig {
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
  };
}

export function buildGenerateLessonDeps(
  env: Record<string, string | undefined> = process.env,
): GenerateLessonDeps {
  const config = buildGeneratorConfig(env);
  // TODO(real adapters): when ANTHROPIC_API_KEY / ELEVENLABS_API_KEY are set, swap in
  // the Claude (Mastra workflow) and ElevenLabs Text-to-Dialogue adapters here.
  return {
    llm: new MockLlmAdapter(),
    tts: new MockTtsAdapter(config.wordsPerMinute),
    config,
  };
}
