/**
 * Connects an `AutoContinue` to a live `AgentSession`: what to ask for, with which context, and which
 * session events mean what. Separate from `agent.ts` so the worker and its tests run the same code.
 */
import { voice } from "@livekit/agents";
import { CONTINUE_MESSAGE } from "@tutor/shared/tutor/session";

import { AutoContinue } from "./auto-continue.ts";

/** The fallback beat between the end of a chunk and asking for the next, and the post-pause wait. */
export const CONTINUE_DELAY_MS = 400;
export const RESUME_DELAY_MS = 1500;
/** A full lesson is ~20 chunks; this only stops a tutor that never finishes. */
export const MAX_CHUNKS_IN_A_ROW = 60;

export function wireAutoContinue(
  session: voice.AgentSession,
  agent: voice.Agent,
  options: { prefetch?: boolean; log?: (message: string) => void } = {},
): AutoContinue {
  const log = options.log ?? ((m: string) => console.log(`[auto-continue] ${m}`));
  const controller = new AutoContinue({
    delayMs: CONTINUE_DELAY_MS,
    resumeDelayMs: RESUME_DELAY_MS,
    maxRun: MAX_CHUNKS_IN_A_ROW,
    fire: (previous) => {
      // A prefetch is asked for while the chunk before it is still being spoken, and that chunk
      // reaches the conversation only once it has been played out. The model must still see it, so
      // the request is handed a context that has it.
      const chatCtx = agent.chatCtx.copy();
      if (previous) {
        const last = chatCtx.items.at(-1);
        const alreadyThere =
          last?.type === "message" &&
          last.role === "assistant" &&
          (last.textContent ?? "").startsWith(previous.slice(0, 40));
        if (!alreadyThere) chatCtx.addMessage({ role: "assistant", content: previous });
      }
      return session.generateReply({ userInput: CONTINUE_MESSAGE, chatCtx });
    },
    canFire: () =>
      (session.agentState === "listening" || session.agentState === "idle") && session.userState !== "speaking",
    canPrefetch: () => session.userState !== "speaking",
    prefetch: options.prefetch,
    log,
  });
  session.on(voice.AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => {
    // The reply `fire` itself creates announces itself here, before `fire` returns.
    if (!controller.creating) controller.speechStarted();
    speechHandle.addDoneCallback((handle) => controller.speechEnded(!handle.interrupted, handle));
  });
  session.on(voice.AgentSessionEventTypes.UserStateChanged, ({ newState }) => {
    if (newState === "speaking") controller.learnerSpoke();
  });
  return controller;
}
