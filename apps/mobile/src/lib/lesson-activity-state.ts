import type { ActivityPhase, ActivityState, ControlIntent } from "@/modules/lesson-activity";

/**
 * Pure derivations for the lock-screen surfaces. No React, no native calls — so the two rules that
 * are easy to get wrong (which words the card shows, and what a stream of presses means) can be
 * reasoned about, and later tested, without a device.
 *
 * See docs/2026-08-16-background-controls-lock-screen.md §5.4, §7.7 and
 * docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md §1.4.
 */

/**
 * How many words the lock-screen card shows.
 *
 * Six was what the layout budget afforded when the card still carried a 44 pt button row. That row
 * is gone (the buttons never worked locked — §1.1), which buys back roughly a line; the number
 * stays at six until probe #3 measures the real cap on a device, because guessing upward is how a
 * card starts clipping its last row.
 */
export const ACTIVITY_WORD_WINDOW = 6;

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
 * The one place `phase` is computed, so the card, the controls and the screen cannot disagree about
 * what the session is doing. `held` outranks `muted` because a pause mutes as part of holding the
 * line — they are one state machine, not two booleans (§3.1).
 */
export function phaseOf(input: { connected: boolean; held: boolean; muted: boolean }): ActivityPhase {
  if (!input.connected) return "over";
  if (input.held) return "held";
  if (input.muted) return "muted";
  return "live";
}

export function buildActivityState(input: {
  title: string;
  deepLink: string;
  words: string[];
  connected: boolean;
  held: boolean;
  muted: boolean;
  silenced: boolean;
}): ActivityState {
  const { words, overflow } = windowWords(input.words);
  return {
    words,
    overflow,
    focusIndex: null, // nothing can compute this yet — §5.2
    phase: phaseOf(input),
    silenced: input.silenced,
    title: input.title,
    deepLink: input.deepLink,
  };
}

/**
 * The one line of text under the title on the Now Playing card.
 *
 * Shorter and blunter than the Live Activity's status line, because it is rendered as an "artist"
 * field in a space that fits a few words — and because the Now Playing card can only ever pause, so
 * it has no mute state to explain.
 *
 * It lives here rather than in Swift while the card's equivalent lives in the widget extension, and
 * that split is deliberate rather than an oversight: the extension renders with no JS process
 * available, so its copy has to be in Swift; the Now Playing card is drawn by the app, so its copy
 * belongs with the rest of the app's copy. Two surfaces, two sentences, neither pretending to be
 * the other. See §1.7.
 */
export function nowPlayingSubtitle(state: ActivityState): string {
  switch (state.phase) {
    case "held":
      return state.silenced
        ? "Paused — the tutor is waiting"
        : "Paused — the tutor may still be audible";
    case "muted":
      return "Muted — the tutor keeps going";
    case "live":
      return "Listening";
    case "over":
      return "Lesson ended";
  }
}

/** Cheap enough to run on every render, and it is what stops an update storm reaching iOS (§7.5). */
export function sameActivityState(a: ActivityState | null, b: ActivityState): boolean {
  if (!a) return false;
  return (
    a.phase === b.phase &&
    a.silenced === b.silenced &&
    a.overflow === b.overflow &&
    a.focusIndex === b.focusIndex &&
    // Compared because they are now pushed state, not frozen attributes: a card re-pointed at a
    // different lesson changes exactly these two and nothing else, and skipping the push would
    // leave yesterday's title on today's lesson. §2.3.
    a.title === b.title &&
    a.deepLink === b.deepLink &&
    a.words.length === b.words.length &&
    a.words.every((word, i) => word === b.words[i])
  );
}

/**
 * What draining the inbox decided.
 *
 * Two fields where there used to be four. `End` is gone with the card's buttons: it existed on a
 * surface that could not run it, the two-tap confirm existed only because a lock screen has no
 * modals, and a Control has room for two toggles rather than three. Ending a lesson is now an
 * in-app action again, which is where a non-idempotent one belongs. §1.4, §3.5.
 */
export type ResolvedIntents = {
  /** Net pause toggles — an odd count flips the hold, an even one is a no-op. */
  togglePause: boolean;
  toggleMute: boolean;
};

/**
 * Resolve a drained inbox.
 *
 * Written as a fold over the batch rather than "did an event arrive" because the inbox can be
 * replayed all at once — the app may have been terminated when the controls were pressed, and every
 * press since then arrives together. Counting toggles rather than taking the last one is the point:
 * three presses is one flip, not three.
 *
 * The controls are `ControlWidgetToggle`s and therefore *do* know which way they were thrown, but
 * what they record is still an untyped toggle. Deliberately: the value they carry is what the
 * control believed at press time, read from a snapshot that may already be stale, whereas the fold
 * resolves against the state as it actually is when the batch is drained. Trusting the desired
 * value would make a stale control able to assert a phase; counting presses cannot.
 */
export function resolveIntents(intents: ControlIntent[]): ResolvedIntents {
  let pauseTaps = 0;
  let muteTaps = 0;

  for (const intent of intents) {
    if (intent.action === "pause") pauseTaps += 1;
    else if (intent.action === "mute") muteTaps += 1;
  }

  return {
    togglePause: pauseTaps % 2 === 1,
    toggleMute: muteTaps % 2 === 1,
  };
}
