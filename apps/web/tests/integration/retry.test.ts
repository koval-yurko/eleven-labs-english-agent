import { describe, expect, it } from "vitest";
import type { GenerateLessonDeps, LlmAdapter, ScriptDraftRequest } from "@idiomatic/generator";
import { buildGeneratorConfig } from "../../lib/generation/deps";
import { makeHarness } from "../helpers";

/** T044/T048 — generation failure → status failed + reason; retry re-runs (FR-016). */

const OWNER = "auth0|alice";

class FailingLlmAdapter implements LlmAdapter {
  readonly modelId = "mock-llm-1";
  readonly promptVersion = "mock-prompt-1";
  async draftScript(_request: ScriptDraftRequest): Promise<never> {
    throw new Error("LLM provider unavailable");
  }
}

function failingDeps(): GenerateLessonDeps {
  return {
    llm: new FailingLlmAdapter(),
    config: buildGeneratorConfig({}),
  };
}

describe("retry", () => {
  it("marks a lesson failed with an error reason when generation throws", async () => {
    const { service, scheduler } = makeHarness({ deps: failingDeps() });
    const outcome = await service.createLesson(OWNER, ["break the ice"]);
    if (!outcome.ok) throw new Error("expected ok");
    await scheduler.settle();

    const detail = await service.getLesson(OWNER, outcome.lesson.id);
    expect(detail?.status).toBe("failed");
    expect(detail?.errorReason).toContain("LLM provider unavailable");
  });

  it("allows retry on a failed lesson and rejects retry on a ready one", async () => {
    const { service, scheduler } = makeHarness({ deps: failingDeps() });
    const outcome = await service.createLesson(OWNER, ["break the ice"]);
    if (!outcome.ok) throw new Error("expected ok");
    await scheduler.settle();

    const retry = await service.retry(OWNER, outcome.lesson.id);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.lesson.status).toBe("generating");

    // A non-existent lesson → 404.
    const missing = await service.retry(OWNER, "does-not-exist");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);
  });

  it("rejects retry on a ready (non-failed) lesson with 409", async () => {
    const { service, scheduler } = makeHarness(); // mock deps succeed
    const outcome = await service.createLesson(OWNER, ["break the ice"]);
    if (!outcome.ok) throw new Error("expected ok");
    await scheduler.settle();

    const retry = await service.retry(OWNER, outcome.lesson.id);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.status).toBe(409);
  });
});
