import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

/**
 * The lock-screen surfaces for a lesson: one read-only Live Activity card, and two Control Center /
 * Lock Screen controls that carry the actions.
 *
 * The split is Apple's, not ours. Buttons inside a widget or Live Activity are inactive on a locked
 * device — the system refuses the press before the intent is consulted — so the card shows and the
 * controls act. See docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md §1.1, §1.4.
 *
 * iOS only, and optional even there: the module is absent on Android and web, on iOS the learner
 * can switch Live Activities off for the app in Settings, and the controls need iOS 18. Every
 * function below degrades to a no-op rather than throwing, because a lesson must never fail because
 * its card could not be drawn. §8.1.
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
  /**
   * The lesson title.
   *
   * Part of the pushed state rather than a start-time argument, and that is the whole of why there
   * is one card instead of one per lesson: `ActivityAttributes` are frozen at request time, so a
   * title living there made "different lesson" mean "different activity" (§2.3).
   */
  title: string;
  /** The deep link behind `Start` once the session is over. Also per-lesson, so also state (§3.6). */
  deepLink: string;
};

/** A press, as recorded by a control. The action is what was pressed, not what should happen. */
export type ControlAction = "pause" | "mute";
export type ControlIntent = { action: ControlAction; at: number };

type NativeModule = {
  isAvailable: () => boolean;
  areControlsSupported: () => boolean;
  activeCount: () => Promise<number>;
  start: (state: ActivityState) => Promise<string | null>;
  update: (state: ActivityState) => Promise<boolean>;
  end: () => Promise<void>;
  publishPhase: (phase: ActivityPhase) => void;
  publishNowPlaying: (title: string, subtitle: string, held: boolean) => void;
  clearNowPlaying: () => void;
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
 * Whether this build and this OS have the two controls.
 *
 * Capability, not adoption — there is no API that reports whether the learner actually added them,
 * and none that could add them on their behalf, so nothing downstream may branch on installation.
 */
export function areControlsSupported(): boolean {
  try {
    return native?.areControlsSupported() ?? false;
  } catch {
    return false;
  }
}

/** How many activities of ours the system still shows. Used by the launch reconcile (§2.7). */
export async function activeActivityCount(): Promise<number> {
  try {
    return (await native?.activeCount()) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Begin the card, or re-point the one that already exists. MUST be called while the app is in the
 * foreground — iOS refuses to start an activity from the background — which the Start tap satisfies
 * by construction.
 *
 * Idempotent across lessons, not just across calls: a card left over from a previous lesson is
 * adopted and re-pointed rather than replaced, and any duplicates found beside it are ended.
 *
 * Resolves to the activity id, or `null` when there is no card (unsupported, disabled, or refused).
 */
export async function startActivity(state: ActivityState): Promise<string | null> {
  try {
    return (await native?.start(state)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Push new state. Resolves to whether a card was actually reached.
 *
 * `false` means there is no longer an activity to update — the system ended it (the 8 h cap), or
 * the learner swiped it away. The caller uses that to stop pushing at nothing, and — importantly —
 * not to immediately request a replacement, because "swiped away" is a decision.
 */
export async function updateActivity(state: ActivityState): Promise<boolean> {
  try {
    return (await native?.update(state)) ?? false;
  } catch {
    // A card that failed to update is a stale card, not a broken lesson.
    return false;
  }
}

/**
 * Tear down every card of ours and clear the shared state the controls read.
 *
 * "Every", not "the one we started": this is also the cleanup path after a crash or a force-quit,
 * where our own bookkeeping is exactly what cannot be trusted.
 *
 * Always paired with a `phase: "over"` push first — never instead of it (§7.1).
 */
export async function endActivity(): Promise<void> {
  try {
    await native?.end();
  } catch {
    // Nothing to do: the alternative to a card we could not end is a card we did not try to end.
  }
}

/**
 * Tell the two controls what the session is doing, and ask the system to redraw them.
 *
 * Deliberately independent of the card. A control's state is *pulled* — the system asks
 * `currentValue()` in the extension's process whenever it chooses — so the answer has to be in
 * shared storage before it is wanted. Tying that to `updateActivity` would tie it to a card that
 * may not exist: Live Activities are switchable off per app in Settings, and the controls have to
 * keep working when they are. It is also the only thing that keeps the lock-screen toggle honest
 * about a pause pressed *inside* the app. (§1.6)
 *
 * Call it on every phase change, before or after the card push — the write is idempotent.
 */
export function publishPhase(phase: ActivityPhase): void {
  try {
    native?.publishPhase(phase);
  } catch {
    // A control that did not redraw is a stale control, and the next phase change will fix it.
  }
}

/**
 * Populate the Now Playing card and enable its play/pause button.
 *
 * The third surface, and the only one the learner gets without visiting Settings — which is exactly
 * the weakness the Controls have. It carries pause only: there is no remote command for muting, and
 * binding one to ⏭ would put a privacy action behind the wrong icon. A pause already mutes, so this
 * is a reduced control rather than an absent one. §1.4 item 4, §1.7.
 *
 * Whether the card appears at all is the open question: LiveKit holds a `playAndRecord` voice-chat
 * session, and a voice-chat session may not be eligible to become the Now Playing app. Nothing here
 * touches the audio session to find out — it publishes and lets iOS decide (probe P-1).
 */
export function publishNowPlaying(title: string, subtitle: string, held: boolean): void {
  try {
    native?.publishNowPlaying(title, subtitle, held);
  } catch {
    // A surface that did not draw is not a broken lesson.
  }
}

export function clearNowPlaying(): void {
  try {
    native?.clearNowPlaying();
  } catch {
    // Same: the alternative to a card we could not clear is a card we did not try to clear.
  }
}

/**
 * Take everything the controls recorded since the last drain, and clear it.
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
      if (action !== "pause" && action !== "mute") return [];
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
 * presses — the inbox is the one that survives the app not running when a control is pressed, so
 * making it the only source of truth means one path to get right instead of two that can disagree
 * (§4.3).
 */
export function addControlIntentListener(listener: () => void): { remove: () => void } {
  const subscription = native?.addListener("onControlIntent", listener);
  return { remove: () => subscription?.remove() };
}
