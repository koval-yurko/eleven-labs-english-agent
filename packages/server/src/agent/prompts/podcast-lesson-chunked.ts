/**
 * The podcast lesson, delivered in chunks — for the LiveKit worker, which can carry on between them.
 *
 * ## Why this exists
 *
 * Lessons 0dd1b82e and eb2cdcc3 (2026-10-10): the first turn was a greeting plus a whole item,
 * 911 and 962 output tokens (4–5 minutes of speech). The learner cut it off after 14–17 seconds both
 * times, so ~95% of what Claude wrote and Qwen synthesized was thrown away, and the 4.2 lesson never
 * finished a single reply. `PODCAST_LESSON_PROMPT` asks for exactly that ("a whole thread, or a whole
 * item, is a normal length for one turn") because the other providers re-engage a silent learner on
 * their own timer and a short turn costs a round trip each; the LiveKit worker has no such timer
 * unless it is given one.
 *
 * This text asks for ~45-second chunks instead — one thread of one item each — and relies on
 * `services/voice-worker/src/auto-continue.ts` to send `CONTINUE_MESSAGE` when a chunk ends and nobody
 * speaks. To the learner it is still one unbroken podcast; the chunking is how it is delivered.
 *
 * ## Derived, not copied
 *
 * Every other word is `PODCAST_LESSON_PROMPT`'s, on purpose: a comparison between `words-4.1` and the
 * version that uses this text must vary the pacing and nothing else. So the text is built by exact
 * replacement of the passages that change, and `replaceExact` throws if a passage is no longer there
 * — an edit to the shared prompt that would silently un-derive this one fails at import instead.
 */
import { CONTINUE_MESSAGE } from "@tutor/shared/tutor/session";
import { PODCAST_LESSON_PROMPT } from "./podcast-lesson";

function replaceExact(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`podcast-lesson-chunked: the shared prompt no longer contains: ${from.slice(0, 80)}…`);
  }
  return text.replace(from, to);
}

const CHUNK_RULES = `PACING — THE APP DELIVERS YOUR TEACHING IN CHUNKS:
- Each turn of yours is ONE CHUNK of about 30 seconds of speech — roughly 80 to 100 words — and every item is taught in FOUR chunks, one thread each, in this order: first the MEANING together with its TRANSLATION; then the FORMS; then the USAGE (the examples, collocations and traps); then the SOUND, which ends by moving on to the next item.
- Chunking splits the teaching; it does NOT shorten it. Every thread keeps the full depth described above, spread over its chunk. Never merge two threads into one chunk to save time, and never skim one. The whole lesson is long, and that is intended.
- Finish every chunk on a complete sentence and simply stop. Do not trail off, do not ask anything, do not announce that you are pausing.
- When a chunk ends and the learner has said nothing, the app sends you a message that begins "${CONTINUE_MESSAGE.slice(0, 12)}" — it is the app, not the learner. Carry on at once with the next thread, in the same breath: no acknowledgement, no recap of the chunk before, no greeting, no "as I was saying". Treat it exactly like the empty turn described above.
- To the learner this is one unbroken podcast. The chunking is only how it is delivered, so never mention chunks, parts or the app.
- The learner may still speak at any time. Everything under "Handling interruptions" applies unchanged, and after you have answered you return to the next chunk, not to the start of the one you were in.
`;

let prompt = PODCAST_LESSON_PROMPT;

// 1. The turn-length rule that produced the 4-minute opening.
prompt = replaceExact(
  prompt,
  "- Keep your turns substantial. This is a monologue, not a back-and-forth: a whole thread, or a whole item, is a normal length for one turn. Don't chop the teaching into four-sentence fragments that each rebuild the context the last one just set up.",
  "- Keep each chunk a real piece of teaching, not a four-sentence fragment — but never rebuild context: the next chunk continues the thought, it does not restate it.",
);

// 2. The greeting that used to be followed by a whole item.
prompt = replaceExact(
  prompt,
  "Then start teaching the first item immediately. You lead from beginning to end.",
  "Then teach the FIRST THREAD of the first item (its meaning and translation) and stop at the end of that chunk — the greeting, the plan and the opening thread together are the whole first turn, about 100 words. You lead from beginning to end.",
);

// 3. "Teach one item at a time": the item boundary is announced inside a chunk, not a turn of its own.
prompt = replaceExact(
  prompt,
  "- Teach one item at a time. When you're done with one,",
  "- Teach one item at a time, one thread per chunk. When you're done with one,",
);

// 4. The pacing rules, right before the interruption rules they interact with.
prompt = replaceExact(prompt, "Handling interruptions and follow-ups — THIS IS HOW THE LEARNER TAKES PART:", `${CHUNK_RULES}\nHandling interruptions and follow-ups — THIS IS HOW THE LEARNER TAKES PART:`);

// 5. The end: the worker keeps asking for chunks until the tutor says the lesson is over.
prompt = replaceExact(
  prompt,
  "Then a brief, warm wrap-up and stop.",
  "Then a brief, warm wrap-up. When the wrap-up is done, call the lesson_complete tool — it takes no arguments and nothing is said aloud for it — and stop. Never call it before the wrap-up, and never carry on after it.",
);

export const PODCAST_LESSON_CHUNKED_PROMPT = prompt;
