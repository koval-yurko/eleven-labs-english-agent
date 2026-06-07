import { describe, expect, it } from "vitest";
import {
  classifyInput,
  generateLesson,
  MockLlmAdapter,
  type GeneratorConfig,
} from "../../src/index";
import { CapturingLogger } from "../helpers/capturing-logger";

/** T016 (US1, SC-007) — concurrent generations produce disjoint id-filtered trails. */

const config: GeneratorConfig = {
  teacherVoiceId: "voice-teacher",
  learnerVoiceId: "voice-learner",
  maxTeachableItems: 20,
  targetMinSeconds: 300,
  targetMaxSeconds: 600,
  wordsPerMinute: 150,
  modelId: "mock-llm-1",
};

function run(root: CapturingLogger, lessonId: string, items: string[]) {
  const { accepted } = classifyInput(items);
  return generateLesson(accepted, {
    llm: new MockLlmAdapter(),
    config,
    logger: root.child({ lessonId }),
  });
}

describe("concurrency separation", () => {
  it("never bleeds entries between two concurrent runs", async () => {
    const root = new CapturingLogger("info");

    await Promise.all([
      run(root, "lesson_a", ["break the ice", "spill the beans", "under the weather"]),
      run(root, "lesson_b", ["piece of cake"]),
    ]);

    const a = root.forLesson("lesson_a");
    const b = root.forLesson("lesson_b");

    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // Each id-filtered trail contains only its own entries.
    expect(a.every((e) => e.lessonId === "lesson_a")).toBe(true);
    expect(b.every((e) => e.lessonId === "lesson_b")).toBe(true);
    // The union accounts for every captured entry (no entry escaped a lesson context).
    expect(a.length + b.length).toBe(root.entries.length);
  });
});
