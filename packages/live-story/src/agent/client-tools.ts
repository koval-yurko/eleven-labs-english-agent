import {
  advanceNarration,
  markItemTaught,
  requestConclude,
  setScenario,
  type NarrationState,
} from "../narration/narration-state";

/**
 * Build the `clientTools` map the narrator agent calls (research R1/R3/R4). Each handler is
 * thin glue over the pure narration state machine: it reads the current state, applies the
 * transition, writes it back through the host, and returns a short STRING the agent uses to
 * continue. Declared on the agent (quickstart §1) and bound in the realtime session.
 *
 * The host bridges these stateless SDK callbacks to the React hook's state + side effects
 * (re-pin a changed scenario, record a turn) without the tools knowing about React.
 */
export interface ClientToolsHost {
  getState(): NarrationState;
  setState(next: NarrationState): void;
  /** US2: re-pin a learner-requested scenario change (sendContextualUpdate + record a turn). */
  onScenarioChange?(scenario: string): void;
}

export type ClientToolHandler = (params: Record<string, unknown>) => string;
export type ClientToolMap = Record<string, ClientToolHandler>;

export function buildClientTools(host: ClientToolsHost): ClientToolMap {
  return {
    advanceNarration: () => {
      const step = advanceNarration(host.getState());
      host.setState(step.state);
      return step.instruction;
    },

    markItemTaught: (params) => {
      const itemId = typeof params?.itemId === "string" ? params.itemId : "";
      if (!itemId) return "markItemTaught needs the item's text — please pass it.";
      const step = markItemTaught(host.getState(), itemId);
      host.setState(step.state);
      return step.instruction;
    },

    setScenario: (params) => {
      const scenario = typeof params?.scenario === "string" ? params.scenario : "";
      const step = setScenario(host.getState(), scenario);
      host.setState(step.state);
      // Re-pin via sendContextualUpdate + record a scenario_change turn (R4). Only when the
      // change actually took effect (the new scenario is now in state).
      if (step.state.scenario && step.state.scenario === scenario.trim()) {
        host.onScenarioChange?.(step.state.scenario);
      }
      return step.instruction;
    },

    concludeLesson: () => {
      const res = requestConclude(host.getState());
      host.setState(res.state);
      return res.instruction;
    },
  };
}
