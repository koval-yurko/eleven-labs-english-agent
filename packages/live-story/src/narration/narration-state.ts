import type {
  LessonPlan,
  PlanBeat,
  PlanItem,
  SessionTurnKind,
  SessionTurnRole,
} from "@idiomatic/contracts";

/**
 * Pure narration state machine for the adaptive live story (006-adaptive-live-story).
 * Framework-free so the coverage guarantee, scenario pin, length budget, and completion
 * guard are unit-testable without the realtime SDK or a DOM. The React hook maps SDK
 * callbacks + client-tool calls onto these functions and reacts to the returned state +
 * instruction string (which the agent uses to continue, R1).
 *
 * Invariants (US1):
 * - Coverage is enforced HERE, not at generation time (R3): `advanceNarration` never tells
 *   the agent to conclude while any planned item is uncovered, and `requestConclude` is
 *   REJECTED until every item is covered (FR-004/FR-010/SC-001/SC-004).
 * - Length is a target, not a hard cut (R8/SC-002): the beat budget steers toward a close
 *   only once coverage is met; coverage always wins over the budget.
 *
 * Extended in later slices on the SAME state shape: scenario steering (US2, `setScenario`),
 * barge-in Q&A + clarification escape (US3), and caption correction (US4).
 */

export interface NarrationState {
  readonly beats: readonly PlanBeat[];
  readonly items: readonly PlanItem[];
  /** sourceItemIds taught at least once (R3). */
  readonly covered: ReadonlySet<string>;
  /** Index of the next planned beat to narrate. */
  readonly beatCursor: number;
  /** Count of completed beats (advanceNarration calls) — drives the length budget (R8). */
  readonly beatsNarrated: number;
  /** Estimated number of beats that fits the target length; coverage may exceed it. */
  readonly beatBudget: number;
  /** Current story setting; null = the plan's original setting (US2, FR-008/FR-009). */
  readonly scenario: string | null;
  /** True once the agent has been cleared to conclude. */
  readonly concluded: boolean;
  /** Consecutive unintelligible inputs (US3, FR-016/FR-017). */
  readonly clarificationStreak: number;
}

/** Rough words-per-beat used to translate the target length into a beat budget (R8). */
const WORDS_PER_BEAT = 60;
const DEFAULT_WPM = 150;

export interface CreateNarrationOptions {
  wordsPerMinute?: number;
  scenario?: string | null;
}

export function createNarrationState(
  plan: LessonPlan,
  options: CreateNarrationOptions = {},
): NarrationState {
  const wpm = options.wordsPerMinute ?? DEFAULT_WPM;
  const budgetFromLength = Math.ceil(((plan.targetSeconds / 60) * wpm) / WORDS_PER_BEAT);
  // Never below the plan's own beat count — every authored beat gets narrated.
  const beatBudget = Math.max(plan.beats.length, budgetFromLength);
  return {
    beats: plan.beats,
    items: plan.items,
    covered: new Set(),
    beatCursor: 0,
    beatsNarrated: 0,
    beatBudget,
    scenario: options.scenario ?? null,
    concluded: false,
    clarificationStreak: 0,
  };
}

/* ── Queries ──────────────────────────────────────────────────────────────── */

export function remainingItems(state: NarrationState): PlanItem[] {
  return state.items.filter((i) => !state.covered.has(i.sourceItemId));
}

/** The length budget is "spent" once we've narrated at least as many beats as it allows. */
export function budgetSpent(state: NarrationState): boolean {
  return state.beatsNarrated >= state.beatBudget;
}

/* ── Transitions / tool handlers ──────────────────────────────────────────── */

export interface NarrationStep {
  state: NarrationState;
  /** The instruction the agent should follow next (client-tool return value). */
  instruction: string;
}

/**
 * Called by the agent at the end of each beat (the `advanceNarration` client tool, R1).
 * Returns the next instruction: the next beat, the items still owed, or "conclude" — only
 * once every item is covered AND the budget is spent (R3/R8).
 */
export function advanceNarration(prev: NarrationState): NarrationStep {
  const state: NarrationState = { ...prev, beatsNarrated: prev.beatsNarrated + 1 };
  const owed = remainingItems(state);
  const scenarioClause = pinClause(state.scenario);

  // Conclude only when coverage is met AND the length budget is spent (coverage wins).
  if (owed.length === 0 && budgetSpent(state)) {
    return { state, instruction: concludeInstruction() };
  }

  // Narrate the next authored beat if any remain.
  const beat = state.beats[state.beatCursor];
  if (beat) {
    const next: NarrationState = { ...state, beatCursor: state.beatCursor + 1 };
    return { state: next, instruction: beatInstruction(beat, next, owed, scenarioClause) };
  }

  // Beats exhausted but items still owed — teach them explicitly, even with looser framing
  // (edge case: a late scenario change left items untaught). Coverage over length (R3/R8).
  if (owed.length > 0) {
    return { state, instruction: teachRemainingInstruction(owed, scenarioClause) };
  }

  // Beats exhausted, all covered (short plan under budget) — conclude.
  return { state, instruction: concludeInstruction() };
}

/** The `markItemTaught` client tool — adds an item to the covered set (R3). */
export function markItemTaught(prev: NarrationState, itemRef: string): NarrationStep {
  const item = resolveItem(prev, itemRef);
  if (!item) {
    return {
      state: prev,
      instruction: `I don't recognize "${itemRef}" as a planned item — keep narrating and only mark the planned items.`,
    };
  }
  const covered = new Set(prev.covered);
  covered.add(item.sourceItemId);
  const state: NarrationState = { ...prev, covered };
  const left = remainingItems(state).length;
  const instruction =
    left === 0
      ? `Noted "${item.normalizedText}" — that was the last item; every planned item is now taught.`
      : `Noted "${item.normalizedText}". ${left} item(s) still to teach: ${remainingItems(state)
          .map((i) => i.normalizedText)
          .join(", ")}.`;
  return { state, instruction };
}

/**
 * The `setScenario` client tool (US2, R4). Updates the pinned story setting — the most
 * recent change wins (FR-008/FR-009) — so every subsequent `advanceNarration` return embeds
 * it (via `pinClause`) and the narration stays in the new world for the rest of the session.
 * Coverage is tracked independently of the setting, so a late change never drops an item.
 */
export function setScenario(prev: NarrationState, scenario: string): NarrationStep {
  const trimmed = scenario.trim();
  if (trimmed.length === 0) {
    return {
      state: prev,
      instruction: "I couldn't change the setting — please say the new setting again.",
    };
  }
  const state: NarrationState = { ...prev, scenario: trimmed };
  const owed = remainingItems(state);
  const owedClause =
    owed.length > 0
      ? ` Keep teaching the remaining items in this setting: ${owed
          .map((i) => i.normalizedText)
          .join(", ")}.`
      : " Every planned item is already taught; you may move toward a close in this setting.";
  return {
    state,
    instruction: `From now on the story is set in: ${trimmed}.${owedClause}`,
  };
}

export interface ConcludeResult {
  state: NarrationState;
  ok: boolean;
  instruction: string;
}

/**
 * The `concludeLesson` client tool — REJECTED while any planned item is uncovered (R3),
 * returning the still-owed items so the agent keeps teaching (FR-004).
 */
export function requestConclude(prev: NarrationState): ConcludeResult {
  const owed = remainingItems(prev);
  if (owed.length > 0) {
    return {
      state: prev,
      ok: false,
      instruction: `Not yet — you still must teach: ${owed
        .map((i) => i.normalizedText)
        .join(", ")}. Keep narrating and teach these (calling markItemTaught) before concluding.`,
    };
  }
  return {
    state: { ...prev, concluded: true },
    ok: true,
    instruction:
      "All planned items are taught — bring the lesson to a warm, natural close, then stop.",
  };
}

/* ── Barge-in Q&A + clarification guard (US3, R9) ─────────────────────────── */

/**
 * A real learner utterance (a question) — resets the unintelligible streak (FR-016). The
 * agent answers grounded in the current item and then resumes narration toward the still-owed
 * items; coverage is unaffected, so `remainingItems` continues to drive the loop (FR-015).
 */
export function noteLearnerSpeech(prev: NarrationState): NarrationState {
  if (prev.clarificationStreak === 0) return prev;
  return { ...prev, clarificationStreak: 0 };
}

/**
 * Empty/unintelligible input (a cough, silence, background noise) — never becomes a stored
 * turn and never triggers a spurious answer or scenario change; it just nudges the
 * clarification guard so the learner is asked to repeat (FR-016, R9).
 */
export function noteUnintelligible(prev: NarrationState): NarrationState {
  return { ...prev, clarificationStreak: prev.clarificationStreak + 1 };
}

/** FR-017: after this many consecutive unintelligible inputs, offer a clean way back. */
export const CLARIFICATION_ESCAPE_THRESHOLD = 3;

/** True once the learner has been unintelligible enough times to warrant an escape (FR-017). */
export function shouldOfferReturnToLesson(
  state: NarrationState,
  threshold = CLARIFICATION_ESCAPE_THRESHOLD,
): boolean {
  return state.clarificationStreak >= threshold;
}

/* ── Subtitle captions (US4, R5) ──────────────────────────────────────────── */

/**
 * One finalized, attributed subtitle caption (FR-018/FR-019). The `ref` ties a teacher
 * caption to its persisted turn so a barge-in correction overwrites the SAME turn in caption
 * AND transcript — one corrected-text code path, so they can never diverge (FR-020/FR-022).
 */
export interface Caption {
  role: SessionTurnRole;
  kind: SessionTurnKind;
  text: string;
  ref: string | null;
}

/** Append a finalized turn as the next caption (ordered, FR-019). */
export function appendCaption(list: readonly Caption[], caption: Caption): Caption[] {
  return [...list, caption];
}

/**
 * Replace the most-recent teacher caption's text with the corrected text on barge-in
 * (R5/SC-008) — the caption must never show words that were cut off and never spoken.
 */
export function correctLastTeacherCaption(
  list: readonly Caption[],
  correctedText: string,
): Caption[] {
  const next = [...list];
  for (let i = next.length - 1; i >= 0; i--) {
    const c = next[i];
    if (c && c.role === "teacher") {
      next[i] = { ...c, text: correctedText };
      break;
    }
  }
  return next;
}

/* ── Instruction builders ─────────────────────────────────────────────────── */

function pinClause(scenario: string | null): string {
  return scenario ? `Keep the story set in: ${scenario}. ` : "";
}

function beatInstruction(
  beat: PlanBeat,
  state: NarrationState,
  owed: PlanItem[],
  scenarioClause: string,
): string {
  const teaches = beat.teachesItemIds
    .map((id) => state.items.find((i) => i.sourceItemId === id)?.normalizedText)
    .filter((t): t is string => Boolean(t));
  const teachClause =
    teaches.length > 0
      ? `In this beat, teach and use: ${teaches.join(", ")} — call markItemTaught for each as you cover it. `
      : "";
  const owedClause =
    owed.length > 0
      ? `Items still owed across the lesson: ${owed.map((i) => i.normalizedText).join(", ")}. `
      : "Every planned item is taught — you may move toward a close. ";
  return `${scenarioClause}Narrate the next beat: "${beat.summary}". ${teachClause}${owedClause}When you finish this beat, call advanceNarration.`;
}

function teachRemainingInstruction(owed: PlanItem[], scenarioClause: string): string {
  return `${scenarioClause}You still must teach these planned items before the lesson can end: ${owed
    .map((i) => i.normalizedText)
    .join(", ")}. Teach each one now (calling markItemTaught), keeping the story coherent, then call advanceNarration.`;
}

function concludeInstruction(): string {
  return "Every planned item is taught and you've reached the target length. Bring the lesson to a natural close now and call concludeLesson.";
}

/* ── Internals ────────────────────────────────────────────────────────────── */

/** Resolve a planned item by sourceItemId OR (robustly) by its normalized text. */
function resolveItem(state: NarrationState, ref: string): PlanItem | undefined {
  const trimmed = ref.trim();
  return (
    state.items.find((i) => i.sourceItemId === trimmed) ??
    state.items.find((i) => i.normalizedText.toLowerCase() === trimmed.toLowerCase())
  );
}
