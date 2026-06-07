import { describe, expect, it } from "vitest";
import {
  classifyInput,
  generateLesson,
  MockLlmAdapter,
  MockTtsAdapter,
  type GeneratorConfig,
} from "../../src/index";
import { CapturingLogger } from "../helpers/capturing-logger";

/** T015 (US1, SC-001) — the generator pipeline trail is complete + ordered, filtered by lesson id. */

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
  ttsBatchConcurrency: 3,
};

describe("per-lesson generation trail", () => {
  it("emits a correlated, ordered entry per pipeline stage for one lesson id", async () => {
    const root = new CapturingLogger("info");
    const logger = root.child({ lessonId: "lesson_1", ownerId: "auth0|alice" });
    const { accepted } = classifyInput(["break the ice", "spill the beans"]);

    await generateLesson(accepted, {
      llm: new MockLlmAdapter(),
      tts: new MockTtsAdapter(config.wordsPerMinute),
      config,
      logger,
    });

    const trail = root.forLesson("lesson_1");
    const events = trail.map((e) => e.event);

    // Every executed generator stage is present, in pipeline order.
    expect(events[0]).toBe("generate.draft");
    expect(events).toContain("generate.coverage");
    expect(events).toContain("render.batch");
    expect(events).toContain("render.total");
    expect(events[events.length - 1]).toBe("generate.result");

    // render.batch precedes render.total precedes generate.result.
    expect(events.indexOf("render.batch")).toBeLessThan(events.indexOf("render.total"));
    expect(events.indexOf("render.total")).toBeLessThan(events.indexOf("generate.result"));

    // Every entry carries the correlation id + owner.
    expect(trail.every((e) => e.lessonId === "lesson_1" && e.ownerId === "auth0|alice")).toBe(true);
  });
});
