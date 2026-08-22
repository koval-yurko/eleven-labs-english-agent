/**
 * The held pause, as decisions rather than as a call sequence.
 *
 * ## Why this was extracted
 *
 * The pause is the highest-risk logic in the app and the least testable. It decides, from a handful
 * of facts, which of three things the learner is owed when they come back — and getting it wrong is
 * invisible on a screen: the tutor simply says the wrong thing, plausibly, and nobody can tell it
 * from a model that wandered. Until now it lived inside a React provider that only runs on a phone,
 * against a live billed session, so every one of its branches was checked by hand or not at all.
 *
 * Splitting DECISION from EFFECT is what makes it checkable: `planHold`/`planRelease` are pure and
 * total, `applyHold`/`applyRelease` are the three lines that call a transport. A fake transport
 * (`tutor-transport-fake.ts`) records the calls, so the whole pause can be exercised in
 * `pnpm check:shared` with no device, no network and no React.
 *
 * ## Why it lives here
 *
 * The messages it chooses between — `PAUSE_STOP_MESSAGE`, `ABORTED_RESUME_MESSAGE`,
 * `UNHEARD_RESUME_MESSAGE`, `PAUSE_CONTEXT` — are already in `./tutor`, and the rule for WHICH one
 * is owed is the semantics of those constants. A rule that lives apart from the values it selects is
 * a rule that drifts from them. `mirror-store.ts` is the precedent for an interface + rules pair
 * here with its implementation elsewhere.
 *
 * ## The behaviour, unchanged
 *
 * From docs/2026-08-16-tutor-pause-hold-the-line.md and
 * docs/2026-08-17-short-turns-and-chunked-pause.md. The tutor was either:
 *   - LISTENING when the pause landed → nothing was lost; say nothing and let the learner speak;
 *   - CUT OFF mid-sentence → owed the TAIL of one thought;
 *   - talking UNHEARD through the pause → owed THAT POINT restated.
 * Both of the two that speak are bounded to one turn, which is the whole fix.
 */
import {
  ABORTED_RESUME_MESSAGE,
  PAUSE_CONTEXT,
  PAUSE_STOP_MESSAGE,
  UNHEARD_RESUME_MESSAGE,
  formatHeldResumeContext,
  type TranscriptLine,
} from "./tutor";
import type { TutorCapabilities, TutorTransportControls } from "./tutor-transport";

/** What the hold has to remember so the release can decide. Opaque to the caller; pass it back. */
export interface HoldSnapshot {
  /**
   * Was the tutor mid-sentence when the pause landed — i.e. did we barge in to stop it?
   *
   * This is the fact that decides which of the two speaking branches runs, and it belongs to the
   * conversation that was live: a hold whose line dies must throw it away, because the turn it
   * describes cannot be finished by the agent that comes back.
   */
  aborted: boolean;
  /** How many transcript lines existed when the hold began. */
  atLine: number;
  /** Wall-clock ms at hold time. Supplied by the caller — this package has no clock. */
  since: number;
  /** The learner's OWN mute bit, restored rather than overridden on the way back. */
  wasMuted: boolean;
}

/** How to stop an in-flight turn, given what the provider can do. */
export type BargeIn =
  /** `response.cancel` and friends: costs nothing and leaves no trace in the transcript. */
  | "cancel"
  /** A fake user message: costs a turn, and `HIDDEN_KICKOFF_MESSAGES` filters it back out. */
  | "message"
  /** The tutor was listening. Barging into silence would only provoke a turn. */
  | "none";

export interface HoldPlan {
  bargeIn: BargeIn;
  /** Text for the `"message"` barge-in. Present regardless, so the applier stays branch-free. */
  bargeInText: string;
  /** The context update telling the tutor it is being paused. */
  context: string;
  /** Does this provider need a keep-alive to stop it re-engaging into the silence? */
  heartbeat: boolean;
  snapshot: HoldSnapshot;
}

/**
 * Decide the hold. Pure and total.
 *
 * `speaking` is read at the instant of the press rather than inferred, because it is the difference
 * between interrupting a thought and interrupting nothing.
 */
export function planHold(
  capabilities: TutorCapabilities,
  now: {
    speaking: boolean;
    muted: boolean;
    lineCount: number;
    at: number;
  },
): HoldPlan {
  const aborted = now.speaking;
  return {
    bargeIn: aborted ? (capabilities.cancelTurn ? "cancel" : "message") : "none",
    bargeInText: PAUSE_STOP_MESSAGE,
    context: PAUSE_CONTEXT,
    heartbeat: capabilities.userActivity,
    snapshot: { aborted, atLine: now.lineCount, since: now.at, wasMuted: now.muted },
  };
}

export interface ReleasePlan {
  /** The learner's own choice, put back exactly as it was. */
  micMuted: boolean;
  /** How long the line was held, as a context update the tutor can use. */
  context: string;
  /**
   * The one turn the learner is owed, or `null` when nothing was lost.
   *
   * Never more than one, and never unbounded: a resume that replayed everything was the bug the
   * three separate messages were introduced to fix.
   */
  say: string | null;
}

/**
 * Decide the release. Pure and total.
 *
 * `linesAfterHold` is the transcript slice from `snapshot.atLine` onward — the turns that landed
 * while the learner could not hear. An AGENT line in there means a whole turn played into the void
 * and slipped past the heartbeat.
 */
export function planRelease(
  snapshot: HoldSnapshot,
  now: { lines: TranscriptLine[]; at: number },
): ReleasePlan {
  const context = formatHeldResumeContext((now.at - snapshot.since) / 1000);
  // Order matters and it is not arbitrary: a turn we CUT OFF is owed its tail even if another turn
  // landed afterwards, because the tail is the thing the learner was in the middle of hearing.
  if (snapshot.aborted) {
    return { micMuted: snapshot.wasMuted, context, say: ABORTED_RESUME_MESSAGE };
  }
  const unheard = now.lines.slice(snapshot.atLine).some((line) => line.role === "agent");
  return {
    micMuted: snapshot.wasMuted,
    context,
    say: unheard ? UNHEARD_RESUME_MESSAGE : null,
  };
}

/**
 * Carry out a hold. Returns whether the tutor was actually SILENCED — `false` means it is still
 * audible and the caller is expected to say so rather than claim a silence it did not deliver.
 *
 * Output first, then the microphone: both are instant, and between them they are the whole of what
 * the learner can perceive.
 */
export function applyHold(tx: TutorTransportControls, plan: HoldPlan): boolean {
  const silenced = tx.setOutputSilenced(true);
  tx.setMicMuted(true);
  if (plan.bargeIn === "cancel") tx.cancelTurn();
  else if (plan.bargeIn === "message") tx.say(plan.bargeInText);
  tx.context(plan.context);
  return silenced;
}

/** Carry out a release. The heartbeat is the caller's to stop — it owns the timer. */
export function applyRelease(tx: TutorTransportControls, plan: ReleasePlan): void {
  tx.setMicMuted(plan.micMuted);
  tx.setOutputSilenced(false);
  tx.context(plan.context);
  if (plan.say !== null) tx.say(plan.say);
}
