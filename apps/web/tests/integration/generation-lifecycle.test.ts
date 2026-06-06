import { describe, expect, it } from "vitest";
import { LessonStatusDTO } from "@idiomatic/contracts";
import { makeHarness } from "../helpers";

/** T018 — generation lifecycle pending → generating → ready with measured audio. */

const OWNER = "auth0|alice";

describe("generation lifecycle", () => {
  it("creates a pending lesson then completes to ready with covered items + audio", async () => {
    const { service, scheduler, repo } = makeHarness();

    const outcome = await service.createLesson(OWNER, [
      "break the ice",
      "spill the beans",
      "under the weather",
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // 202 payload conforms to the contract and starts as pending.
    expect(() => LessonStatusDTO.parse(outcome.lesson)).not.toThrow();
    expect(outcome.lesson.status).toBe("pending");
    expect(outcome.lesson.acceptedItemCount).toBe(3);

    // Background generation runs to completion.
    await scheduler.settle();

    const detail = await service.getLesson(OWNER, outcome.lesson.id);
    expect(detail?.status).toBe("ready");
    expect(detail?.audio?.durationSeconds).toBeGreaterThan(0);
    expect(detail?.audio?.url).toContain(outcome.lesson.id);
    // Every teachable item is marked covered (FR-009/SC-002).
    expect(detail?.items).toHaveLength(3);
    expect(detail?.items.every((i) => i.covered)).toBe(true);

    // Persisted lesson carries reproducibility metadata (Constitution III).
    const record = await repo.getLesson(OWNER, outcome.lesson.id);
    expect(record?.modelId).toBe("mock-llm-1");
    expect(record?.audioDurationSeconds).toBeGreaterThan(0);
  });

  it("survives the learner leaving: lesson is present after generation settles", async () => {
    const { service, scheduler } = makeHarness();
    const outcome = await service.createLesson(OWNER, ["serendipity"]);
    if (!outcome.ok) throw new Error("expected ok");

    // Simulate the learner leaving before generation finishes, then returning.
    await scheduler.settle();
    const detail = await service.getLesson(OWNER, outcome.lesson.id);
    expect(detail?.status).toBe("ready");
  });
});
