import { describe, expect, it } from "vitest";
import { makeHarness } from "../helpers.js";

/** T019/T043 — submit guardrails + mixed-input skip report (FR-004/005/006/007). */

const OWNER = "auth0|alice";

describe("submit guardrails", () => {
  it("rejects empty input with 400 empty_input (FR-004)", async () => {
    const { service } = makeHarness();
    const r = await service.createLesson(OWNER, "   \n  ");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("empty_input");
    }
  });

  it("declines when nothing is teachable with 400 no_teachable_items (FR-007)", async () => {
    const { service } = makeHarness();
    const r = await service.createLesson(OWNER, ["12345", "xkcdfgh"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("no_teachable_items");
      expect(r.skipped?.length).toBe(2);
    }
  });

  it("rejects oversized input with 413 and the limit, no silent drop (FR-005)", async () => {
    const { service } = makeHarness();
    const many = Array.from({ length: 25 }, (_, i) => `idiom number ${i}`);
    const r = await service.createLesson(OWNER, many);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(413);
      expect(r.limit).toBe(20);
      expect(r.received).toBe(25);
    }
  });

  it("proceeds with teachable items and reports skipped ones (FR-006)", async () => {
    const { service, scheduler } = makeHarness();
    const r = await service.createLesson(OWNER, ["break the ice", "12345", "spill the beans"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lesson.acceptedItemCount).toBe(2);
    expect(r.lesson.skipped).toEqual([{ rawText: "12345", reason: "gibberish" }]);

    await scheduler.settle();
    const detail = await service.getLesson(OWNER, r.lesson.id);
    // Only teachable items are taught; skip report is preserved in detail.
    expect(detail?.items).toHaveLength(2);
    expect(detail?.skipped).toEqual([{ rawText: "12345", reason: "gibberish" }]);
  });
});
