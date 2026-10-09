import { llm } from "@livekit/agents";
import { z } from "zod";

/**
 * `lesson_complete`: how the tutor says a chunked lesson is over.
 *
 * The worker keeps asking a chunked lesson for its next chunk (`auto-continue.ts`); without a signal
 * from the tutor it would ask after the wrap-up too, forever. The prompt
 * (`podcast-lesson-chunked.ts`) has the tutor call this once, after the wrap-up.
 *
 * It returns nothing on purpose: LiveKit runs a follow-up reply after a tool only when the tool
 * returned something (`replyRequired: toolOutput !== undefined` in its generation code), and a
 * follow-up here would be the tutor talking after it said goodbye.
 */
export function lessonCompleteTool(onComplete: () => void) {
  return llm.tool({
    description:
      "Call this once, after your closing wrap-up, to end the lesson. It takes no arguments and " +
      "nothing is said aloud for it. Never call it before the wrap-up is finished.",
    parameters: z.object({}),
    execute: async () => {
      onComplete();
    },
  });
}
