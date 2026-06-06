import { describe, expect, it } from "vitest";
import { LessonScript } from "@idiomatic/contracts";
import {
  classifyInput,
  generateLesson,
  MockLlmAdapter,
  MockTtsAdapter,
  validateCoverage,
  type GeneratorConfig,
} from "../../src/index.js";

/** End-to-end orchestrator with mock providers (research R11): coverage + duration. */

const config: GeneratorConfig = {
  teacherVoiceId: "voice-teacher",
  learnerVoiceId: "voice-learner",
  maxTeachableItems: 20,
  targetMinSeconds: 300,
  targetMaxSeconds: 600,
  wordsPerMinute: 150,
  ttsCharLimit: 3000,
};

describe("generateLesson", () => {
  it("produces a valid, coverage-complete script and measured audio", async () => {
    const { accepted } = classifyInput([
      "break the ice",
      "spill the beans",
      "under the weather",
    ]);

    const result = await generateLesson(accepted, {
      llm: new MockLlmAdapter(),
      tts: new MockTtsAdapter(config.wordsPerMinute),
      config,
    });

    // Structurally valid against the shared contract.
    expect(() => LessonScript.parse(result.script)).not.toThrow();

    // Every accepted item is covered (FR-009/SC-002).
    const coverage = validateCoverage(
      accepted.map((i) => i.id),
      result.script,
    );
    expect(coverage.ok).toBe(true);

    // Two distinct voices present (FR-013).
    expect(result.script.speakers.teacher.voiceId).toBe("voice-teacher");
    expect(result.script.speakers.learner.voiceId).toBe("voice-learner");
    expect(result.script.speakers.teacher.voiceId).not.toBe(
      result.script.speakers.learner.voiceId,
    );

    // Audio measured (SC-003) and reproducibility metadata captured (Constitution III).
    expect(result.audio.durationSeconds).toBeGreaterThan(0);
    expect(result.audio.mimeType).toBe("audio/mpeg");
    expect(result.metadata.modelId).toBe("mock-llm-1");
    expect(result.metadata.acceptedItemIds).toHaveLength(3);
  });

  it("throws when asked to generate with no accepted items", async () => {
    await expect(
      generateLesson([], {
        llm: new MockLlmAdapter(),
        tts: new MockTtsAdapter(),
        config,
      }),
    ).rejects.toThrow();
  });
});
