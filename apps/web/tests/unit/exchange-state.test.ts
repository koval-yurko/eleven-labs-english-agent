import { describe, expect, it } from "vitest";
import {
  CLARIFICATION_ESCAPE_THRESHOLD,
  hasCapturableTurns,
  initialExchange,
  reduceExchange,
  shouldOfferReturnToLesson,
  type ExchangeEvent,
  type ExchangeState,
} from "../../lib/live-tutor/exchange-state";

/**
 * T021 / T022 / T023 / T035 — Unit tests for the exchange state machine: barge-in keeps
 * the interruption point fixed, turns accumulate across barge-ins, and repeated
 * unintelligible input trips the return-to-lesson escape.
 */

function run(events: ExchangeEvent[], start: ExchangeState = initialExchange): ExchangeState {
  return events.reduce(reduceExchange, start);
}

describe("interruption point (T022)", () => {
  it("is fixed at the first interrupt and survives barge-in", () => {
    const state = run([
      { type: "interrupt", positionSeconds: 42.5 },
      { type: "learnerTurn", text: "What does this mean?" },
      { type: "tutorTurn", text: "It means..." },
      // Barge-in: a second interrupt while already open must NOT move the position.
      { type: "interrupt", positionSeconds: 88.0 },
      { type: "learnerTurn", text: "Can you give an example?" },
      { type: "tutorTurn", text: "Sure, imagine..." },
    ]);
    expect(state.interruptionPositionSeconds).toBe(42.5);
  });
});

describe("multi-turn accumulation (T021/T023)", () => {
  it("keeps all turns in order across barge-ins", () => {
    const state = run([
      { type: "interrupt", positionSeconds: 10 },
      { type: "learnerTurn", text: "Q1" },
      { type: "tutorTurn", text: "A1" },
      { type: "learnerTurn", text: "Q2" },
      { type: "tutorTurn", text: "A2" },
    ]);
    expect(state.turns.map((t) => `${t.role}:${t.text}:${t.turnIndex}`)).toEqual([
      "learner:Q1:0",
      "tutor:A1:1",
      "learner:Q2:2",
      "tutor:A2:3",
    ]);
    expect(hasCapturableTurns(state)).toBe(true);
  });

  it("close resets to the initial state", () => {
    const state = run([
      { type: "interrupt", positionSeconds: 5 },
      { type: "learnerTurn", text: "Q" },
      { type: "close" },
    ]);
    expect(state).toEqual(initialExchange);
    expect(hasCapturableTurns(state)).toBe(false);
  });
});

describe("clarification escape guard (T035/FR-015)", () => {
  it("offers a return after the threshold of consecutive unintelligible inputs", () => {
    let state = run([{ type: "interrupt", positionSeconds: 0 }]);
    expect(shouldOfferReturnToLesson(state)).toBe(false);

    for (let i = 0; i < CLARIFICATION_ESCAPE_THRESHOLD; i++) {
      state = reduceExchange(state, { type: "unintelligible" });
    }
    expect(state.clarificationStreak).toBe(CLARIFICATION_ESCAPE_THRESHOLD);
    expect(shouldOfferReturnToLesson(state)).toBe(true);
  });

  it("a real learner turn resets the streak", () => {
    let state = run([
      { type: "interrupt", positionSeconds: 0 },
      { type: "unintelligible" },
      { type: "unintelligible" },
    ]);
    expect(state.clarificationStreak).toBe(2);
    state = reduceExchange(state, { type: "learnerTurn", text: "Okay, what does it mean?" });
    expect(state.clarificationStreak).toBe(0);
    expect(shouldOfferReturnToLesson(state)).toBe(false);
  });
});
