import { describe, expect, it } from "vitest";
import type { LessonScript } from "@idiomatic/contracts";
import type { GenerateLessonDeps, TtsAdapter } from "@idiomatic/generator";
import { MockLlmAdapter } from "@idiomatic/generator";
import { buildGeneratorConfig } from "../../lib/generation/deps";
import { captureLogger, makeHarness } from "../helpers";

/** T022 (US2, SC-002) — failure emits generate.error {stage, reason} + generating → failed. */

const OWNER = "auth0|alice";

class FailingTtsAdapter implements TtsAdapter {
  async renderDialogue(_script: LessonScript): Promise<never> {
    throw new Error("TTS provider unavailable");
  }
}

function failingDeps(): GenerateLessonDeps {
  return {
    llm: new MockLlmAdapter(),
    tts: new FailingTtsAdapter(),
    config: buildGeneratorConfig({}),
  };
}

describe("failure logging", () => {
  it("records the failing stage + reason and the failed transition", async () => {
    const cap = captureLogger("info");
    const { service, scheduler } = makeHarness({ deps: failingDeps(), logger: cap.logger });

    const outcome = await service.createLesson(OWNER, ["break the ice"]);
    if (!outcome.ok) throw new Error("expected ok");
    await scheduler.settle();

    const trail = cap.forLesson(outcome.lesson.id);

    const error = trail.find((e) => e.event === "generate.error");
    expect(error).toBeDefined();
    expect(error?.level).toBe("error");
    expect(error?.fields?.stage).toBe("generation");
    expect(error?.fields?.reason).toContain("TTS provider unavailable");

    const failed = trail
      .filter((e) => e.event === "lesson.status")
      .find((e) => e.fields?.to === "failed");
    expect(failed?.fields?.from).toBe("generating");
    expect(failed?.fields?.reason).toContain("TTS provider unavailable");
  });

  it("retry of a failed lesson logs failed → generating", async () => {
    const cap = captureLogger("info");
    const { service, scheduler } = makeHarness({ deps: failingDeps(), logger: cap.logger });

    const outcome = await service.createLesson(OWNER, ["break the ice"]);
    if (!outcome.ok) throw new Error("expected ok");
    await scheduler.settle();

    const retry = await service.retry(OWNER, outcome.lesson.id);
    expect(retry.ok).toBe(true);
    await scheduler.settle();

    const transitions = cap
      .forLesson(outcome.lesson.id)
      .filter((e) => e.event === "lesson.status")
      .map((e) => ({ from: e.fields?.from, to: e.fields?.to }));

    // First run failed, retry re-enters from the failed state.
    expect(transitions).toContainEqual({ from: "pending", to: "generating" });
    expect(transitions).toContainEqual({ from: "generating", to: "failed" });
    expect(transitions).toContainEqual({ from: "failed", to: "generating" });
  });
});
