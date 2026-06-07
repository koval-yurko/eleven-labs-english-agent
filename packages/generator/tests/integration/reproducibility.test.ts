import { describe, expect, it } from "vitest";
import {
  classifyInput,
  generateLesson,
  MockLlmAdapter,
  MockTtsAdapter,
  type GeneratorConfig,
  type LogEntry,
} from "../../src/index";
import { CapturingLogger } from "../helpers/capturing-logger";

/** T017 (US1, SC-008) — generate.result makes input count + model + prompt version recoverable. */

const config: GeneratorConfig = {
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

describe("reproducibility summary", () => {
  it("records itemCount, modelId, and promptVersion on generate.result", async () => {
    const root = new CapturingLogger("info");
    const { accepted } = classifyInput(["break the ice", "spill the beans", "under the weather"]);

    await generateLesson(accepted, {
      llm: new MockLlmAdapter(),
      tts: new MockTtsAdapter(config.wordsPerMinute),
      config,
      logger: root.child({ lessonId: "lesson_1" }),
    });

    const result = root.entries.find((e: LogEntry) => e.event === "generate.result");
    expect(result).toBeDefined();
    expect(result?.fields?.itemCount).toBe(3);
    expect(result?.fields?.modelId).toBe("mock-llm-1");
    expect(result?.fields?.promptVersion).toBe("mock-prompt-1");
  });
});
