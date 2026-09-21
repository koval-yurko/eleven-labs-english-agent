/**
 * The turn-taking presets: plan name → `AgentSession` `turnHandling` values. Research doc §2 Q4's
 * table, defined once in code (§10.3 point 2) so the dispatch call site passes a plan name, never
 * hand-typed numbers.
 *
 * The plan names match Vapi's (`apps/web/src/agent/vapi-assistant.ts`), so a prompt version means
 * the same thing on every provider. The values are STARTING ESTIMATES. Phase 4 tunes them against
 * the L4 replay corpus of real learner speech.
 *
 * agents-js takes milliseconds here, while the research doc's table is written in seconds.
 */
import type { voice } from "@livekit/agents";
import type { LiveKitDispatchMetadata } from "@tutor/shared/tutor/livekit-wire";

export type TurnPlan = NonNullable<LiveKitDispatchMetadata["turnPlan"]>;

type TurnHandling = NonNullable<voice.AgentSessionOptions["turnHandling"]>;

export const TURN_PLANS = {
  /** Learners who stop mid-sentence to search for a word. words-3.x runs on this one. */
  patient: {
    endpointing: { minDelay: 800, maxDelay: 4000 },
    interruption: { minDuration: 800, minWords: 2 },
  },
  normal: {
    endpointing: { minDelay: 500, maxDelay: 3000 },
    interruption: { minDuration: 500, minWords: 1 },
  },
  eager: {
    endpointing: { minDelay: 300, maxDelay: 2000 },
    interruption: { minDuration: 300, minWords: 0 },
  },
} as const satisfies Record<TurnPlan, TurnHandling>;

/** A lesson that names no plan gets "patient": this app's learners pause to think, and a tutor
 *  that waits a beat too long costs less than one that cuts them off. */
export const DEFAULT_TURN_PLAN: TurnPlan = "patient";

export function turnHandlingFor(plan: TurnPlan | undefined): TurnHandling {
  return TURN_PLANS[plan ?? DEFAULT_TURN_PLAN];
}
