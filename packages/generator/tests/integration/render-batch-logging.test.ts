import { describe, expect, it } from "vitest";
import {
  classifyInput,
  generateLesson,
  MockLlmAdapter,
  MockTtsAdapter,
  type GeneratorConfig,
} from "../../src/index";
import { CapturingLogger } from "../helpers/capturing-logger";

/** T028 (US3, SC-005) — a render.batch timing is present for every batch + a render.total. */

const baseConfig: GeneratorConfig = {
  teacherVoiceId: "voice-teacher",
  learnerVoiceId: "voice-learner",
  maxTeachableItems: 20,
  targetMinSeconds: 300,
  targetMaxSeconds: 600,
  wordsPerMinute: 150,
  ttsCharLimit: 3000,
  modelId: "mock-llm-1",
  ttsModelId: "eleven_v3",
  ttsBitrate: 128000,
};

describe("render batch logging", () => {
  it("emits a render.batch per batch with the expected fields, then one render.total", async () => {
    // A tiny char limit forces multiple batches so batchCount > 1 is meaningful.
    const config: GeneratorConfig = { ...baseConfig, ttsCharLimit: 80 };
    const root = new CapturingLogger("info");
    const { accepted } = classifyInput(["break the ice", "spill the beans", "under the weather"]);

    await generateLesson(accepted, {
      llm: new MockLlmAdapter(),
      tts: new MockTtsAdapter(config.wordsPerMinute),
      config,
      logger: root.child({ lessonId: "lesson_1" }),
    });

    const batches = root.entries.filter((e) => e.event === "render.batch");
    expect(batches.length).toBeGreaterThan(1);

    const declaredCount = batches[0]?.fields?.batchCount as number;
    expect(batches).toHaveLength(declaredCount);

    batches.forEach((entry, i) => {
      expect(entry.fields?.batchIndex).toBe(i);
      expect(entry.fields?.batchCount).toBe(declaredCount);
      expect(typeof entry.fields?.chars).toBe("number");
      expect(typeof entry.fields?.durationMs).toBe("number");
    });

    const total = root.entries.filter((e) => e.event === "render.total");
    expect(total).toHaveLength(1);
    expect(total[0]?.fields?.audioDurationSeconds).toBeGreaterThan(0);
  });
});
