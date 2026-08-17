import type { ActivityPhase, ActivityState, ControlIntent } from "@/modules/lesson-activity";

/**
 * Pure derivations for the lock-screen card. No React, no native calls — so the two rules that are
 * easy to get wrong (which words the card shows, and what a stream of taps means) can be reasoned
 * about, and later tested, without a device.
 *
 * See docs/2026-08-16-background-controls-lock-screen.md §3.5, §5.4, §7.7.
 */

/**
 * How many words the lock-screen card shows.
 *
 * Six is what the layout budget affords once the header is dropped, the words go into two columns
 * and the buttons become icons (§5.4). It is an estimate until probe #3 measures it on a device; if
 * the measurement disagrees, this constant is the thing to change.
 */
export const ACTIVITY_WORD_WINDOW = 6;

/**
 * How long an armed End confirm stays armed.
 *
 * Long enough to be a decision rather than a reflex, short enough that a confirm armed and forgotten
 * cannot end a lesson when the learner comes back to the phone minutes later.
 */
export const END_CONFIRM_MS = 5_000;

/**
 * How long the card lingers after the session ends, offering `Start`.
 *
 * It exists at all because `Start` cannot be an action on a locked device (§3.6) — the card has to
 * survive its session to be the way back in. Two minutes is long enough for a learner who put the
 * phone down when the tutor hung up, short enough that a card for a finished lesson is not still
 * sitting there the next morning.
 */
export const OVER_CARD_LINGER_MS = 120_000;

/** The window the card renders, plus how many active words it left out. */
export function windowWords(words: string[]): { words: string[]; overflow: number } {
  return {
    words: words.slice(0, ACTIVITY_WORD_WINDOW),
    overflow: Math.max(0, words.length - ACTIVITY_WORD_WINDOW),
  };
}

/**
 * The one place `phase` is computed, so the card and the screen cannot disagree about what the
 * session is doing. `held` outranks `muted` because a pause mutes as part of holding the line —
 * they are one state machine, not two booleans (§3.1).
 */
export function phaseOf(input: { connected: boolean; held: boolean; muted: boolean }): ActivityPhase {
  if (!input.connected) return "over";
  if (input.held) return "held";
  if (input.muted) return "muted";
  return "live";
}

export function buildActivityState(input: {
  words: string[];
  connected: boolean;
  held: boolean;
  muted: boolean;
  silenced: boolean;
  confirmingEnd: boolean;
}): ActivityState {
  const { words, overflow } = windowWords(input.words);
  return {
    words,
    overflow,
    focusIndex: null, // nothing can compute this yet — §5.2
    phase: phaseOf(input),
    silenced: input.silenced,
    confirmingEnd: input.confirmingEnd,
  };
}

/** Cheap enough to run on every render, and it is what stops an update storm reaching iOS (§7.5). */
export function sameActivityState(a: ActivityState | null, b: ActivityState): boolean {
  if (!a) return false;
  return (
    a.phase === b.phase &&
    a.silenced === b.silenced &&
    a.confirmingEnd === b.confirmingEnd &&
    a.overflow === b.overflow &&
    a.focusIndex === b.focusIndex &&
    a.words.length === b.words.length &&
    a.words.every((word, i) => word === b.words[i])
  );
}

/** What draining the inbox decided. `end` is the only one that is not simply "the learner tapped". */
export type ResolvedIntents = {
  /** Net pause toggles — an odd count flips the hold, an even one is a no-op. */
  togglePause: boolean;
  toggleMute: boolean;
  /** Two End taps inside the window. Ending is the action; arming is not. */
  end: boolean;
  /** A single End tap: arm the confirm and show it. */
  armEndConfirm: boolean;
};

/**
 * Resolve a drained inbox against the confirm state.
 *
 * Written as a fold over timestamps rather than "did an event arrive" because the inbox can be
 * replayed in a batch — the app may have been terminated when the buttons were pressed, and every
 * tap since then arrives at once. Two End taps that land together must collapse to ONE end, and an
 * End armed ten minutes ago must resolve to none. Counting toggles rather than taking the last one
 * is the same idea for pause and mute: three taps is one flip, not three.
 */
export function resolveIntents(
  intents: ControlIntent[],
  armedAt: number | null,
  now: number,
): ResolvedIntents {
  let pauseTaps = 0;
  let muteTaps = 0;
  let armed = armedAt !== null && now - armedAt <= END_CONFIRM_MS ? armedAt : null;
  let end = false;

  for (const intent of [...intents].sort((a, b) => a.at - b.at)) {
    switch (intent.action) {
      case "pause":
        pauseTaps += 1;
        // Reaching for a different control is a decision not to end. §3.5.
        armed = null;
        break;
      case "mute":
        muteTaps += 1;
        armed = null;
        break;
      case "end":
        if (armed !== null && intent.at - armed <= END_CONFIRM_MS) {
          end = true;
          armed = null;
        } else {
          armed = intent.at;
        }
        break;
    }
  }

  // An end supersedes everything queued with it: pausing a session that is about to be torn down is
  // work whose only observable effect would be a contextual update the tutor never reads.
  if (end) return { togglePause: false, toggleMute: false, end: true, armEndConfirm: false };

  return {
    togglePause: pauseTaps % 2 === 1,
    toggleMute: muteTaps % 2 === 1,
    end: false,
    armEndConfirm: armed !== null,
  };
}

/** The timestamp a resolved confirm should be remembered at, or `null` to disarm. */
export function nextArmedAt(intents: ControlIntent[], resolved: ResolvedIntents): number | null {
  if (!resolved.armEndConfirm) return null;
  const ends = intents.filter((i) => i.action === "end");
  return ends.length > 0 ? Math.max(...ends.map((i) => i.at)) : null;
}
