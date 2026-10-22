import { llm } from "@livekit/agents";
import { z } from "zod";

import type { Backend } from "./backend.ts";

/**
 * `add_words_to_collection`, as a tool the worker owns.
 *
 * On the three hosted providers this same tool is reached over MCP, because ElevenLabs, OpenAI and
 * Vapi run the model for us and need a way to call back in. Here we run the model ourselves, so the
 * tool is an ordinary function that posts to a grant-authenticated route — and the word lands with
 * the learner's real `owner_id` instead of the `NULL` the MCP path is stuck with. The reasoning is
 * in docs/2026-09-25-lesson-grant-tool-authorization.md.
 *
 * Declared only when a grant exists (`agent.ts`). A tutor that has been handed a saving tool it
 * cannot use would promise the learner a word was kept and be wrong.
 *
 * The description is the only guard the `words-4.x` versions have: their prompt is the bare podcast
 * lesson, without `SAVE_TO_COLLECTION_CLAUSE`. It used to invite saving "a word worth keeping", and
 * in all four lessons of 2026-10-22 the tutor saved today's own items unasked, heard "already
 * present", and wrapped the lesson up as done (reports 1ea56197, dd64d531, dbd66780, 06389b51). So
 * it now carries the clause's two rules: only on request, never the lesson's own items.
 */

/** The MCP tool's own limits, so the two paths refuse the same inputs. */
const MAX_WORDS = 50;
const MAX_WORD_LENGTH = 500;

export function saveWordsTool(backend: Backend) {
  // No `name`: in object syntax the key it is registered under becomes the tool name, and passing
  // both is a type error rather than a duplicate.
  return llm.tool({
    description:
      "Save English words, phrases or sentences to the learner's vocabulary collection. Use it ONLY " +
      "when the learner asks you to save or remember something. Never save anything they did not ask " +
      "for, and never save the items in today's lesson: they are already in the collection, which is " +
      "where the lesson came from. Saving does not end or advance the lesson; confirm it in a few " +
      "words and carry on teaching where you were.",
    parameters: z.object({
      words: z
        .array(z.string().min(1).max(MAX_WORD_LENGTH))
        .min(1)
        .max(MAX_WORDS)
        .describe("English words, phrases or full sentences. One entry per item."),
    }),
    execute: async ({ words }) => {
      const result = await backend.addWords(words);
      /**
       * The failure the learner SHOULD hear about. Every other backend failure in this worker is a
       * lost measurement the lesson can survive not knowing about; this one is a word they asked to
       * keep. Saying so is better than a tutor that cheerfully confirms a save that never happened.
       */
      if (!result) {
        return {
          ok: false,
          message: "The collection could not be reached, so nothing was saved. Tell the learner.",
        };
      }
      return {
        ok: true,
        added: result.added.map((w) => w.text),
        already_present: result.already_present.map((w) => w.text),
        skipped: result.skipped,
      };
    },
  });
}
