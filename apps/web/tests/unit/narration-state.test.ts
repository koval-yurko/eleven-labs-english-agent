import { describe, expect, it } from "vitest";
import type { LessonPlan } from "@idiomatic/contracts";
import {
  advanceNarration,
  appendCaption,
  type Caption,
  CLARIFICATION_ESCAPE_THRESHOLD,
  correctLastTeacherCaption,
  createNarrationState,
  markItemTaught,
  noteLearnerSpeech,
  noteUnintelligible,
  remainingItems,
  requestConclude,
  setScenario,
  shouldOfferReturnToLesson,
  type NarrationState,
} from "@idiomatic/live-story";

/**
 * T014 [US1] — Unit tests for the pure narration state machine. Coverage guarantee, the
 * completion guard (conclude only when all items covered AND budget spent), and that
 * `concludeLesson` is rejected while any item is uncovered (R3/R8, FR-004/FR-010/SC-001).
 */

function plan(overrides: Partial<LessonPlan> = {}): LessonPlan {
  return {
    lessonId: "lesson-1",
    items: [
      { sourceItemId: "si-1", normalizedText: "break the ice", itemType: "idiom" },
      { sourceItemId: "si-2", normalizedText: "piece of cake", itemType: "idiom" },
    ],
    beats: [
      { index: 0, summary: "intro", teachesItemIds: [] },
      { index: 1, summary: "ice beat", teachesItemIds: ["si-1"] },
      { index: 2, summary: "cake beat", teachesItemIds: ["si-2"] },
    ],
    targetSeconds: 300,
    teacherVoiceId: "voice-x",
    ...overrides,
  };
}

/** Drive advanceNarration until it tells the agent to conclude or we hit a guard rail. */
function runToConclude(start: NarrationState, maxSteps = 50): { state: NarrationState; instruction: string } {
  let state = start;
  let instruction = "";
  for (let i = 0; i < maxSteps; i++) {
    const step = advanceNarration(state);
    state = step.state;
    instruction = step.instruction;
    if (/concludeLesson/.test(instruction)) break;
  }
  return { state, instruction };
}

describe("createNarrationState", () => {
  it("starts with nothing covered and at beat 0", () => {
    const s = createNarrationState(plan());
    expect(s.beatCursor).toBe(0);
    expect(s.covered.size).toBe(0);
    expect(remainingItems(s)).toHaveLength(2);
  });
});

describe("markItemTaught", () => {
  it("covers an item by sourceItemId and reports the remaining count", () => {
    const s0 = createNarrationState(plan());
    const { state, instruction } = markItemTaught(s0, "si-1");
    expect(state.covered.has("si-1")).toBe(true);
    expect(remainingItems(state)).toHaveLength(1);
    expect(instruction).toContain("piece of cake");
  });

  it("also resolves an item by its normalized text", () => {
    const s0 = createNarrationState(plan());
    const { state } = markItemTaught(s0, "Piece Of Cake");
    expect(state.covered.has("si-2")).toBe(true);
  });

  it("does not cover an unknown ref", () => {
    const s0 = createNarrationState(plan());
    const { state } = markItemTaught(s0, "nope");
    expect(state.covered.size).toBe(0);
  });
});

describe("advanceNarration completion guard", () => {
  it("never tells the agent to conclude while an item is uncovered", () => {
    let s = createNarrationState(plan());
    // Cover NOTHING; advance many times — it must keep asking to teach, never conclude.
    for (let i = 0; i < 20; i++) {
      const step = advanceNarration(s);
      s = step.state;
      expect(step.instruction).not.toMatch(/concludeLesson/);
    }
    expect(remainingItems(s).length).toBeGreaterThan(0);
  });

  it("concludes only after every item is covered AND the budget is spent", () => {
    let s = createNarrationState(plan());
    s = markItemTaught(s, "si-1").state;
    s = markItemTaught(s, "si-2").state;
    const { state, instruction } = runToConclude(s);
    expect(remainingItems(state).length).toBe(0);
    expect(instruction).toMatch(/concludeLesson/);
  });

  it("teaches still-owed items even after the authored beats are exhausted (coverage > length)", () => {
    let s = createNarrationState(plan());
    // Burn through all beats without covering anything.
    for (let i = 0; i < 5; i++) s = advanceNarration(s).state;
    const step = advanceNarration(s);
    expect(step.instruction).toMatch(/still must teach|still owed|to teach/i);
    expect(step.instruction).not.toMatch(/concludeLesson/);
  });
});

describe("setScenario (US2)", () => {
  it("updates the pinned scenario and embeds it in every subsequent advanceNarration return", () => {
    let s = createNarrationState(plan());
    s = setScenario(s, "space travel").state;
    expect(s.scenario).toBe("space travel");
    const step = advanceNarration(s);
    expect(step.instruction).toContain("space travel");
  });

  it("latest wins on repeated changes", () => {
    let s = createNarrationState(plan());
    s = setScenario(s, "space travel").state;
    s = setScenario(s, "a pirate ship").state;
    expect(s.scenario).toBe("a pirate ship");
    expect(advanceNarration(s).instruction).toContain("a pirate ship");
    expect(advanceNarration(s).instruction).not.toContain("space travel");
  });

  it("ignores a blank scenario (no change)", () => {
    let s = createNarrationState(plan());
    s = setScenario(s, "space travel").state;
    const res = setScenario(s, "   ");
    expect(res.state.scenario).toBe("space travel");
  });

  it("still completes coverage after a late scenario change", () => {
    let s = createNarrationState(plan());
    // Cover one item, then change setting very late, then cover the rest.
    s = markItemTaught(s, "si-1").state;
    for (let i = 0; i < 5; i++) s = advanceNarration(s).state; // burn beats
    s = setScenario(s, "the deep sea").state;
    expect(remainingItems(s).length).toBeGreaterThan(0);
    // The machine must still demand the owed item, not conclude.
    const step = advanceNarration(s);
    expect(step.instruction).toContain("piece of cake");
    expect(step.instruction).toContain("the deep sea");
    s = markItemTaught(step.state, "si-2").state;
    expect(remainingItems(s).length).toBe(0);
    expect(requestConclude(s).ok).toBe(true);
  });
});

describe("barge-in Q&A + clarification guard (US3)", () => {
  it("a question resumes narration toward the remaining items (coverage unaffected)", () => {
    let s = createNarrationState(plan());
    s = markItemTaught(s, "si-1").state;
    // A real learner question arrives mid-narration.
    s = noteLearnerSpeech(s);
    expect(s.clarificationStreak).toBe(0);
    // After the exchange, the loop still owes the uncovered item.
    expect(advanceNarration(s).instruction).toContain("piece of cake");
    expect(remainingItems(s).map((i) => i.sourceItemId)).toEqual(["si-2"]);
  });

  it("unintelligible input stores no turn and raises the clarification streak", () => {
    let s = createNarrationState(plan());
    s = noteUnintelligible(s);
    s = noteUnintelligible(s);
    expect(s.clarificationStreak).toBe(2);
    // Coverage and beats are untouched by garbled input.
    expect(s.covered.size).toBe(0);
    expect(s.beatsNarrated).toBe(0);
  });

  it("a real question resets the streak", () => {
    let s = createNarrationState(plan());
    s = noteUnintelligible(s);
    s = noteUnintelligible(s);
    s = noteLearnerSpeech(s);
    expect(s.clarificationStreak).toBe(0);
    expect(shouldOfferReturnToLesson(s)).toBe(false);
  });

  it("offers a clean return to the lesson after the escape threshold", () => {
    let s = createNarrationState(plan());
    for (let i = 0; i < CLARIFICATION_ESCAPE_THRESHOLD; i++) s = noteUnintelligible(s);
    expect(shouldOfferReturnToLesson(s)).toBe(true);
  });
});

describe("captions + barge-in correction (US4)", () => {
  const teacher = (text: string, ref: string): Caption => ({ role: "teacher", kind: "narration", text, ref });
  const learner = (text: string): Caption => ({ role: "learner", kind: "question", text, ref: null });

  it("appends finalized, attributed captions in order", () => {
    let cs: Caption[] = [];
    cs = appendCaption(cs, teacher("Two strangers waited...", "t0"));
    cs = appendCaption(cs, learner("What does that mean?"));
    expect(cs.map((c) => c.role)).toEqual(["teacher", "learner"]);
    expect(cs[0]?.text).toContain("Two strangers");
  });

  it("corrects the just-rendered teacher caption to only what was actually spoken", () => {
    let cs: Caption[] = [];
    cs = appendCaption(cs, teacher("Two strangers waited at a bus stop and began to chat about—", "t0"));
    cs = appendCaption(cs, learner("Wait, what's a bus stop?"));
    // Barge-in truncated the teacher mid-sentence; the correction replaces the LAST teacher caption.
    cs = correctLastTeacherCaption(cs, "Two strangers waited at a bus stop");
    const lastTeacher = cs.filter((c) => c.role === "teacher").at(-1);
    expect(lastTeacher?.text).toBe("Two strangers waited at a bus stop");
    expect(lastTeacher?.text).not.toContain("began to chat");
    // The learner caption after it is untouched.
    expect(cs.at(-1)?.role).toBe("learner");
  });
});

describe("requestConclude", () => {
  it("is rejected while any item is uncovered, listing the still-owed items", () => {
    const s = createNarrationState(plan());
    const res = requestConclude(s);
    expect(res.ok).toBe(false);
    expect(res.instruction).toContain("break the ice");
    expect(res.instruction).toContain("piece of cake");
    expect(res.state.concluded).toBe(false);
  });

  it("is accepted once all items are covered", () => {
    let s = createNarrationState(plan());
    s = markItemTaught(s, "si-1").state;
    s = markItemTaught(s, "si-2").state;
    const res = requestConclude(s);
    expect(res.ok).toBe(true);
    expect(res.state.concluded).toBe(true);
  });
});
