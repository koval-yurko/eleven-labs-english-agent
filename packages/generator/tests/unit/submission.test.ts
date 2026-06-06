import { describe, expect, it } from "vitest";
import { decideSubmission } from "../../src/index";

/** Input-guardrail decisions (FR-004/005/006/007). */

const MAX = 20;

describe("decideSubmission", () => {
  it("rejects empty input (FR-004)", () => {
    const d = decideSubmission("   \n  ", MAX);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("empty_input");
  });

  it("declines when nothing is teachable (FR-007)", () => {
    const d = decideSubmission(["12345", "xkcdfgh"], MAX);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("no_teachable_items");
  });

  it("rejects oversized input with the limit and received count, no silent drop (FR-005)", () => {
    const many = Array.from({ length: 25 }, (_, i) => `idiom number ${i}`);
    const d = decideSubmission(many, MAX);
    expect(d.ok).toBe(false);
    if (!d.ok && d.code === "too_many_items") {
      expect(d.status).toBe(413);
      expect(d.limit).toBe(MAX);
      expect(d.received).toBe(25);
    } else {
      throw new Error("expected too_many_items");
    }
  });

  it("proceeds with teachable items and reports skipped ones (FR-006)", () => {
    const d = decideSubmission(["break the ice", "12345", "spill the beans"], MAX);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.acceptedCount).toBe(2);
      expect(d.skipped).toEqual([{ rawText: "12345", reason: "gibberish" }]);
    }
  });
});
