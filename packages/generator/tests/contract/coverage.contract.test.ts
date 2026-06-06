import { describe, expect, it } from "vitest";
import type { LessonScript } from "@idiomatic/contracts";
import { LESSON_SCRIPT_VERSION } from "@idiomatic/contracts";
import { validateCoverage } from "../../src/index.js";

/**
 * T017 — Contract test: the coverage guarantee (FR-009/SC-002). Every accepted
 * teachable item must be referenced by ≥1 existing segment; misses and dangling
 * segment refs are detected.
 */

function script(partial: Partial<LessonScript>): LessonScript {
  return {
    version: LESSON_SCRIPT_VERSION,
    speakers: {
      learner: { role: "learner", voiceId: "vl" },
      teacher: { role: "teacher", voiceId: "vt" },
    },
    segments: [{ id: "s1", speaker: "teacher", text: "..." }],
    coverage: [],
    estimatedDurationSeconds: 60,
    ...partial,
  };
}

describe("coverage validation", () => {
  it("passes when every accepted item maps to an existing segment", () => {
    const s = script({
      segments: [
        { id: "s1", speaker: "teacher", text: "a" },
        { id: "s2", speaker: "teacher", text: "b" },
      ],
      coverage: [
        { sourceItemId: "item-0", normalizedText: "x", segmentIds: ["s1"] },
        { sourceItemId: "item-1", normalizedText: "y", segmentIds: ["s2"] },
      ],
    });
    const result = validateCoverage(["item-0", "item-1"], s);
    expect(result.ok).toBe(true);
    expect(result.uncovered).toEqual([]);
  });

  it("flags an item with no coverage entry", () => {
    const s = script({
      coverage: [{ sourceItemId: "item-0", normalizedText: "x", segmentIds: ["s1"] }],
    });
    const result = validateCoverage(["item-0", "item-1"], s);
    expect(result.ok).toBe(false);
    expect(result.uncovered).toEqual(["item-1"]);
  });

  it("treats coverage referencing a non-existent segment as uncovered + dangling", () => {
    const s = script({
      coverage: [{ sourceItemId: "item-0", normalizedText: "x", segmentIds: ["ghost"] }],
    });
    const result = validateCoverage(["item-0"], s);
    expect(result.ok).toBe(false);
    expect(result.uncovered).toEqual(["item-0"]);
    expect(result.danglingSegmentRefs).toContain("ghost");
  });
});
