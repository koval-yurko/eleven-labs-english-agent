/** The held pause as decisions rather than a call sequence: planHold/planRelease are pure, applyHold/applyRelease touch the transport.
 *  See ../../docs/tutor.md. */
import {
  ABORTED_RESUME_MESSAGE,
  PAUSE_CONTEXT,
  PAUSE_STOP_MESSAGE,
  UNHEARD_RESUME_MESSAGE,
  formatHeldResumeContext,
  type TranscriptLine,
} from "./session";
import type { TutorCapabilities, TutorTransportControls } from "./transport";

export interface HoldSnapshot {
  aborted: boolean;
  atLine: number;
  since: number;
  wasMuted: boolean;
}

export type BargeIn =
  | "cancel"
  /** A fake user message: costs a turn, and `HIDDEN_KICKOFF_MESSAGES` filters it back out. */
  | "message"
  /** The tutor was listening. Barging into silence would only provoke a turn. */
  | "none";

export interface HoldPlan {
  bargeIn: BargeIn;
  bargeInText: string;
  context: string;
  heartbeat: boolean;
  snapshot: HoldSnapshot;
}

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
  micMuted: boolean;
  context: string;
  say: string | null;
}

export function planRelease(
  snapshot: HoldSnapshot,
  now: { lines: TranscriptLine[]; at: number },
): ReleasePlan {
  const context = formatHeldResumeContext((now.at - snapshot.since) / 1000);
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

export function applyHold(tx: TutorTransportControls, plan: HoldPlan): boolean {
  const silenced = tx.setOutputSilenced(true);
  tx.setMicMuted(true);
  if (plan.bargeIn === "cancel") tx.cancelTurn();
  else if (plan.bargeIn === "message") tx.say(plan.bargeInText);
  tx.context(plan.context);
  return silenced;
}

export function applyRelease(tx: TutorTransportControls, plan: ReleasePlan): void {
  tx.setMicMuted(plan.micMuted);
  tx.setOutputSilenced(false);
  tx.context(plan.context);
  if (plan.say !== null) tx.say(plan.say);
}
