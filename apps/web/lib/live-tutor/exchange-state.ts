import type { QaTurnRole } from "@idiomatic/contracts";

/**
 * Pure state machine for one live Q&A exchange (US1/US2/US4). Kept framework-free so the
 * barge-in / turn-accumulation / clarification-guard rules are unit-testable without the
 * realtime SDK or a DOM. The React controller maps SDK callbacks to these events and
 * reacts to the resulting state (pause/resume/persist).
 *
 * Invariants:
 * - The interruption position is fixed at the FIRST interruption and never moves, no
 *   matter how many barge-in turns follow (FR-010 / US2 / T022).
 * - Turns accumulate in order across barge-ins within one exchange (US2 / T023).
 * - Consecutive unintelligible inputs raise a clarification streak that the UI uses to
 *   offer a guaranteed escape back to the lesson (FR-015 / US4 / T035).
 */

export interface QaTurnDraft {
  role: QaTurnRole;
  text: string;
  turnIndex: number;
}

export interface ExchangeState {
  open: boolean;
  interruptionPositionSeconds: number | null;
  turns: QaTurnDraft[];
  clarificationStreak: number;
}

export const initialExchange: ExchangeState = {
  open: false,
  interruptionPositionSeconds: null,
  turns: [],
  clarificationStreak: 0,
};

export type ExchangeEvent =
  | { type: "interrupt"; positionSeconds: number }
  | { type: "learnerTurn"; text: string }
  | { type: "tutorTurn"; text: string }
  | { type: "unintelligible" }
  | { type: "close" };

export function reduceExchange(state: ExchangeState, event: ExchangeEvent): ExchangeState {
  switch (event.type) {
    case "interrupt":
      // Open the exchange and FIX the resume point. A barge-in mid-exchange must not
      // move it (T022), so we only set it when the exchange isn't already open.
      if (state.open) return state;
      return {
        open: true,
        interruptionPositionSeconds: event.positionSeconds,
        turns: [],
        clarificationStreak: 0,
      };

    case "learnerTurn": {
      const base = state.open ? state : { ...initialExchange, open: true };
      return {
        ...base,
        turns: [...base.turns, { role: "learner", text: event.text, turnIndex: base.turns.length }],
        clarificationStreak: 0, // a real question resets the unintelligible streak
      };
    }

    case "tutorTurn": {
      if (!state.open) return state;
      return {
        ...state,
        turns: [...state.turns, { role: "tutor", text: event.text, turnIndex: state.turns.length }],
      };
    }

    case "unintelligible":
      // Empty/garbled input never becomes a stored turn; it just nudges the guard.
      return { ...state, clarificationStreak: state.clarificationStreak + 1 };

    case "close":
      return initialExchange;

    default:
      return state;
  }
}

/** FR-015: after this many consecutive unintelligible inputs, offer a clean exit. */
export const CLARIFICATION_ESCAPE_THRESHOLD = 3;

export function shouldOfferReturnToLesson(
  state: ExchangeState,
  threshold = CLARIFICATION_ESCAPE_THRESHOLD,
): boolean {
  return state.clarificationStreak >= threshold;
}

/** True when the exchange holds at least one real turn worth persisting (US4 edge: no spurious save). */
export function hasCapturableTurns(state: ExchangeState): boolean {
  return state.turns.length > 0;
}
