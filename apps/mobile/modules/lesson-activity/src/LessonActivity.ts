import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

/**
 * The lock-screen Live Activity — the lesson's controls while the phone is locked.
 *
 * iOS only, and optional even there: the module is absent on Android and web, and on iOS the
 * learner can switch Live Activities off for the app in Settings. Every function below degrades to
 * a no-op rather than throwing, because a lesson must never fail because its card could not be
 * drawn. See docs/2026-08-16-background-controls-lock-screen.md §8.1.
 */

/** What the session is doing. Mirrors `LessonActivityAttributes.Phase`. */
export type ActivityPhase = "live" | "muted" | "held" | "over";

/** The payload pushed on every change. Mirrors `LessonActivityAttributes.ContentState`. */
export type ActivityState = {
  /** Already windowed by the caller — the extension renders what it is given. */
  words: string[];
  /** How many active words did not fit the window. `0` hides the affordance. */
  overflow: number;
  /** Reserved: nothing can compute the current word yet (§5.2). */
  focusIndex: number | null;
  phase: ActivityPhase;
  /** `false` means the tutor may still be audible during a pause — shown, never hidden (§7.6). */
  silenced: boolean;
  /** First End tap arms this; a second inside the window ends the session (§3.5). */
  confirmingEnd: boolean;
};

/** A tap, as recorded by an intent. The action is what was pressed, not what should happen. */
export type ControlAction = "pause" | "mute" | "end";
export type ControlIntent = { action: ControlAction; at: number };

type NativeModule = {
  isAvailable: () => boolean;
  start: (title: string, deepLink: string, state: ActivityState) => Promise<string | null>;
  update: (state: ActivityState) => Promise<boolean>;
  end: () => Promise<void>;
  drainIntents: () => { action?: unknown; at?: unknown }[];
  addListener: (name: "onControlIntent", listener: () => void) => { remove: () => void };
};

/**
 * `requireOptionalNativeModule`, not `requireNativeModule`: this file is imported by the lesson
 * screen, which also runs on Android and in any build made before this module existed. The optional
 * form returns null there instead of throwing at import time.
 */
const native =
  Platform.OS === "ios" ? requireOptionalNativeModule<NativeModule>("LessonActivity") : null;

/** Whether a card can be shown at all — iOS 16.2+, module present, and not disabled in Settings. */
export function isActivityAvailable(): boolean {
  try {
    return native?.isAvailable() ?? false;
  } catch {
    return false;
  }
}

/**
 * Begin the card. MUST be called while the app is in the foreground — iOS refuses to start an
 * activity from the background — which the Start tap satisfies by construction.
 *
 * Resolves to the activity id, or `null` when there is no card (unsupported, disabled, or refused).
 */
export async function startActivity(
  title: string,
  deepLink: string,
  state: ActivityState,
): Promise<string | null> {
  try {
    return (await native?.start(title, deepLink, state)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Push new state. Resolves to whether a card was actually reached.
 *
 * `false` means there is no longer an activity to update — the system ended it (the 8 h cap), or
 * the learner swiped it away. The caller uses that to stop pushing at nothing, rather than assuming
 * the card it started is still there.
 */
export async function updateActivity(state: ActivityState): Promise<boolean> {
  try {
    return (await native?.update(state)) ?? false;
  } catch {
    // A card that failed to update is a stale card, not a broken lesson.
    return false;
  }
}

/** Tear the card down. Always paired with a `phase: "over"` push first — never instead of it (§7.1). */
export async function endActivity(): Promise<void> {
  try {
    await native?.end();
  } catch {
    // Nothing to do: the alternative to a card we could not end is a card we did not try to end.
  }
}

/**
 * Take everything the buttons recorded since the last drain, and clear it.
 *
 * Shapes are validated here rather than trusted: the inbox is App Group `UserDefaults`, which is
 * shared mutable state written by a second binary, and a malformed entry should be dropped rather
 * than crash a live lesson.
 */
export function drainControlIntents(): ControlIntent[] {
  try {
    const raw = native?.drainIntents() ?? [];
    return raw.flatMap((entry) => {
      const action = entry.action;
      const at = entry.at;
      if (action !== "pause" && action !== "mute" && action !== "end") return [];
      if (typeof at !== "number" || !Number.isFinite(at)) return [];
      return [{ action, at }];
    });
  } catch {
    return [];
  }
}

/**
 * Subscribe to "something landed in the inbox".
 *
 * The event carries no payload on purpose. It is a nudge to drain, not a second delivery path for
 * taps — the inbox is the one that survives the app not running when a button is pressed, so making
 * it the only source of truth means one path to get right instead of two that can disagree (§4.3).
 */
export function addControlIntentListener(listener: () => void): { remove: () => void } {
  const subscription = native?.addListener("onControlIntent", listener);
  return { remove: () => subscription?.remove() };
}
