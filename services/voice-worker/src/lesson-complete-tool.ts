import { llm } from "@livekit/agents";
import { z } from "zod";

/**
 * `lesson_complete`: how the tutor says a chunked lesson is over.
 *
 * Two consequences, one per callback:
 *  - `onComplete`, at once: the worker keeps asking a chunked lesson for its next chunk
 *    (`auto-continue.ts`); without a signal from the tutor it would ask after the wrap-up too,
 *    forever;
 *  - `onFinished`, once the wrap-up has been heard: the lesson ends properly instead of leaving the
 *    phone connected to a tutor that will never speak again. The tool waits for the playout of the
 *    words that came before it (`RunContext.waitForPlayout`, which LiveKit documents for exactly this),
 *    and skips `onFinished` if the learner talked over the goodbye — they are still in the lesson.
 *
 * It returns nothing on purpose: LiveKit runs a follow-up reply after a tool only when the tool
 * returned something (`replyRequired: toolOutput !== undefined` in its generation code), and a
 * follow-up here would be the tutor talking after it said goodbye.
 */
export function lessonCompleteTool(callbacks: { onComplete: () => void; onFinished: () => void }) {
  return llm.tool({
    description:
      "Call this once, after your closing wrap-up, to end the lesson. It takes no arguments and " +
      "nothing is said aloud for it. Never call it before the wrap-up is finished.",
    parameters: z.object({}),
    execute: async (_args, { ctx }) => {
      callbacks.onComplete();
      await ctx.waitForPlayout();
      if (!ctx.speechHandle.interrupted) callbacks.onFinished();
    },
  });
}
