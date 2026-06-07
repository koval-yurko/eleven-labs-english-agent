import { describe, expect, it } from "vitest";
import type { LessonScript } from "@idiomatic/contracts";
import { derivePlan, type PlanSourceItem } from "@idiomatic/generator";

/**
 * T013 [US1] — Unit test for the pure `derivePlan` (packages/generator/src/workflow/derive-plan.ts).
 * Asserts: ordered teachable items, beats grouped by coverage, the targetSeconds clamp, and
 * that a malformed script (an item taught by no beat) throws — the plan-time coverage mirror.
 */

function script(): LessonScript {
  return {
    version: "1.0",
    speakers: {
      learner: { role: "learner", voiceId: "learner-voice" },
      teacher: { role: "teacher", voiceId: "teacher-voice" },
    },
    segments: [
      { id: "s-intro", speaker: "teacher", text: "Let's turn a few expressions into little stories." },
      { id: "s-ice-t", speaker: "teacher", text: "Two strangers used 'break the ice' at a bus stop." },
      { id: "s-ice-l", speaker: "learner", text: "Ah, so that's break the ice." },
      { id: "s-cake-t", speaker: "teacher", text: "Later, the exam was a 'piece of cake'." },
      { id: "s-cake-l", speaker: "learner", text: "Got it, piece of cake." },
    ],
    coverage: [
      { sourceItemId: "gen-1", normalizedText: "break the ice", segmentIds: ["s-ice-t"] },
      { sourceItemId: "gen-2", normalizedText: "piece of cake", segmentIds: ["s-cake-t"] },
    ],
    estimatedDurationSeconds: 1200, // above the max so the clamp is exercised
  };
}

// Persisted source items carry the AUTHORITATIVE ids (different from coverage's generation-time ids).
function items(): PlanSourceItem[] {
  return [
    { id: "si-ice", normalizedText: "break the ice", itemType: "idiom", teachable: true, orderIndex: 0 },
    { id: "si-cake", normalizedText: "piece of cake", itemType: "idiom", teachable: true, orderIndex: 1 },
    { id: "si-skip", normalizedText: "nonsense", itemType: "word", teachable: false, orderIndex: 2 },
  ];
}

const config = { targetMinSeconds: 300, targetMaxSeconds: 600 };

describe("derivePlan", () => {
  it("produces ordered teachable PlanItems (skipping non-teachable), keyed on persisted ids", () => {
    const plan = derivePlan(script(), items(), config);
    expect(plan.items.map((i) => i.sourceItemId)).toEqual(["si-ice", "si-cake"]);
    expect(plan.items.map((i) => i.normalizedText)).toEqual(["break the ice", "piece of cake"]);
  });

  it("uses the persisted teacher voice id", () => {
    expect(derivePlan(script(), items(), config).teacherVoiceId).toBe("teacher-voice");
  });

  it("groups segments into beats and attaches teachesItemIds by persisted id", () => {
    const plan = derivePlan(script(), items(), config);
    // Each taught item appears in exactly one beat's teachesItemIds, by PERSISTED id.
    const taught = plan.beats.flatMap((b) => b.teachesItemIds);
    expect(taught).toContain("si-ice");
    expect(taught).toContain("si-cake");
    expect(taught).not.toContain("gen-1"); // never the generation-time coverage id
    // A new teaching focus opens a new beat → the two items are in different beats.
    const iceBeat = plan.beats.find((b) => b.teachesItemIds.includes("si-ice"));
    const cakeBeat = plan.beats.find((b) => b.teachesItemIds.includes("si-cake"));
    expect(iceBeat?.index).not.toBe(cakeBeat?.index);
  });

  it("clamps targetSeconds into the configured window (R8)", () => {
    expect(derivePlan(script(), items(), config).targetSeconds).toBe(600); // 1200 clamped to max
    const short = { ...script(), estimatedDurationSeconds: 120 };
    expect(derivePlan(short, items(), config).targetSeconds).toBe(300); // below min → min
  });

  it("throws when a teachable item is taught by no beat (malformed script)", () => {
    const broken = script();
    broken.coverage = broken.coverage.filter((c) => c.normalizedText !== "piece of cake");
    expect(() => derivePlan(broken, items(), config)).toThrow();
  });

  it("throws when there are no teachable items", () => {
    const none = items().map((i) => ({ ...i, teachable: false }));
    expect(() => derivePlan(script(), none, config)).toThrow();
  });
});
