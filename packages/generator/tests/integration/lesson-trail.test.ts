import { describe, expect, it } from "vitest";
import {
  classifyInput,
  generateLesson,
  MockLlmAdapter,
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
  modelId: "mock-llm-1",
};

describe("per-lesson generation trail", () => {
  it("emits a correlated, ordered entry per pipeline stage for one lesson id", async () => {
    const root = new CapturingLogger("info");
    const logger = root.child({ lessonId: "lesson_1", ownerId: "auth0|alice" });
    const { accepted } = classifyInput(["break the ice", "spill the beans"]);

    await generateLesson(accepted, {
      llm: new MockLlmAdapter(),
      config,
      logger,
    });

    const trail = root.forLesson("lesson_1");
    const events = trail.map((e) => e.event);

    // Every executed generator stage is present, in pipeline order (plan-only, no render).
    expect(events[0]).toBe("generate.draft");
    expect(events).toContain("generate.coverage");
    expect(events[events.length - 1]).toBe("generate.result");

    // No audio-render stages remain in the trail (007-live-only).
    expect(events).not.toContain("render.batch");
    expect(events).not.toContain("render.total");

    // generate.coverage precedes generate.result.
    expect(events.indexOf("generate.coverage")).toBeLessThan(events.indexOf("generate.result"));

    // Every entry carries the correlation id + owner.
    expect(trail.every((e) => e.lessonId === "lesson_1" && e.ownerId === "auth0|alice")).toBe(true);
  });
});
