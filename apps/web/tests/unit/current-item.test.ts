import { describe, expect, it } from "vitest";
import type { LessonScript } from "@idiomatic/contracts";
import {
  buildItemTimeline,
  resolveItemAtPosition,
} from "../../lib/live-tutor/current-item";

/**
 * T010 — Unit test for the current-item resolver (research R3). Char-proportional
 * offsets over the script; boundary/gap → most-recently-started item; before the first
 * covered item → null.
 */

const script: LessonScript = {
  version: "1.0",
  speakers: {
    learner: { role: "learner", voiceId: "v-learner" },
    teacher: { role: "teacher", voiceId: "v-teacher" },
  },
  segments: [
    { id: "seg-1", speaker: "teacher", text: "Welcome to today's lesson, let's begin." },
    { id: "seg-2", speaker: "learner", text: "I'm ready!" },
    { id: "seg-3", speaker: "teacher", text: "Break the ice means to ease initial tension." },
    { id: "seg-4", speaker: "teacher", text: "Spill the beans means to reveal a secret." },
  ],
  coverage: [
    { sourceItemId: "gen-a", normalizedText: "break the ice", segmentIds: ["seg-3"] },
    { sourceItemId: "gen-b", normalizedText: "spill the beans", segmentIds: ["seg-4"] },
  ],
  estimatedDurationSeconds: 120,
};

const items = [
  { id: "uuid-a", normalizedText: "break the ice", teachable: true },
  { id: "uuid-b", normalizedText: "spill the beans", teachable: true },
];

describe("buildItemTimeline", () => {
  it("maps coverage to persisted item ids by normalizedText, ordered by start", () => {
    const timeline = buildItemTimeline(script, items, 120);
    expect(timeline.map((e) => e.sourceItemId)).toEqual(["uuid-a", "uuid-b"]);
    expect(timeline[0]!.startSeconds).toBeLessThan(timeline[1]!.startSeconds);
    // First covered item starts after the intro segments (not at 0).
    expect(timeline[0]!.startSeconds).toBeGreaterThan(0);
  });

  it("skips coverage whose item is not among teachable rows", () => {
    const timeline = buildItemTimeline(script, [items[0]!], 120);
    expect(timeline.map((e) => e.sourceItemId)).toEqual(["uuid-a"]);
  });
});

describe("resolveItemAtPosition", () => {
  const timeline = buildItemTimeline(script, items, 120);
  const aStart = timeline[0]!.startSeconds;
  const bStart = timeline[1]!.startSeconds;

  it("returns null before the first covered item (pre-first)", () => {
    expect(resolveItemAtPosition(timeline, 0)).toBeNull();
    expect(resolveItemAtPosition(timeline, aStart - 0.01)).toBeNull();
  });

  it("returns the first item while it is active", () => {
    expect(resolveItemAtPosition(timeline, aStart)?.sourceItemId).toBe("uuid-a");
    expect(resolveItemAtPosition(timeline, bStart - 0.01)?.sourceItemId).toBe("uuid-a");
  });

  it("returns the most-recently-started item at/after its start (boundary → most recent)", () => {
    expect(resolveItemAtPosition(timeline, bStart)?.sourceItemId).toBe("uuid-b");
    expect(resolveItemAtPosition(timeline, 9999)?.sourceItemId).toBe("uuid-b");
  });
});
