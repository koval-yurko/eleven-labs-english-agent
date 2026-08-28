/**
 * words-2.1 — the podcast lesson on OpenAI, with the collection open to the tutor.
 *
 * `words-2.0` plus one capability: the learner can ask for a word to be saved and the tutor saves
 * it, by calling `add_words_to_collection` on our own MCP server (`/api/mcp`). OpenAI dials that
 * server themselves; see ../openai-mcp.ts for the mechanism and docs/2026-08-28-openai-realtime-mcp-tools.md
 * for why it is shaped this way.
 *
 * ## Why this is a new version and not an edit to 2.0
 *
 * Because `words-1.0`, `words-2.0` and `words-3.0` are the same prompt BYTE FOR BYTE on three
 * services, and that is the only reason the three-way comparison means anything (./podcast-lesson.ts).
 * Appending a tool clause to the shared text would have changed all three; setting `mcpTools` on 2.0
 * without a clause would have changed what 2.0 does while leaving its module claiming otherwise.
 * A fourth entry costs one file and keeps both statements true.
 *
 * The prompt is therefore composed, not copied: `PODCAST_LESSON_PROMPT` unchanged, plus the clause
 * below. Diffing 2.0 against 2.1 shows exactly one thing, which is the point.
 *
 * ## What the clause is careful about
 *
 * Three failure modes, each seen in the shape of this lesson rather than invented:
 *
 *  1. **The tutor narrating the tool.** This is a podcast; "let me add that to your collection,
 *     calling the tool now" is a machine talking about itself. It saves and says one clause.
 *  2. **The tutor saving the session's own items.** They are already in the collection — that is
 *     where the list came from — so a well-meaning tutor could spend the lesson re-adding them. The
 *     server would dedupe (`resolve_words` + `on conflict`), but the model would still stop teaching
 *     to do it.
 *  3. **Saving unasked.** The tool writes to the learner's vocabulary, and a tutor that hoovered up
 *     every related word it mentioned would fill the collection with words the learner never chose.
 *     The learner asks; the tutor saves.
 *
 * ## The ownership caveat, stated where someone will see it
 *
 * A word saved this way has `owner_id` NULL — MCP writes are anonymous, because the shared token
 * names a caller and not a person (docs/2026-08-27-mcp-static-token-auth.md §2). It shows up in the
 * collection because the reads widen to unowned rows, so with ONE learner this is invisible and
 * correct-looking. With two learners it would be a word saved in one lesson appearing in the other
 * learner's collection. That is the thing to fix before this version is offered to a second person,
 * and it is a property of the SERVER, not of this prompt.
 */
import { PODCAST_LESSON_PROMPT } from "./podcast-lesson";
import type { PromptVersion } from "./types";

/**
 * The one addition to the shared text. Placed after it, so the lesson is read first and the tool is
 * an affordance inside a lesson rather than the first thing the model learns about its job.
 *
 * Worded as an interruption rule on purpose: interruptions are already how the learner takes part
 * in this lesson ("Handling interruptions and follow-ups — THIS IS HOW THE LEARNER TAKES PART"), so
 * "save that one" is a new kind of request in a mechanism the prompt has already established,
 * instead of a new mechanism.
 */
const SAVE_TO_COLLECTION_CLAUSE = `

Saving words to the learner's collection:
- You have one tool, add_words_to_collection, which puts English words or phrases into the learner's vocabulary collection so they can practise them in a later session.
- Use it ONLY when the learner asks you to — "save that one", "add that to my list", "I want to keep 'break the ice'". Never save anything they didn't ask for, and never save the items in today's list: those are already in their collection, which is where today's lesson came from.
- If they ask for something vague ("save that"), save the item or phrase you were just talking about. If it's genuinely unclear which one they mean, ask once, briefly.
- Saving is quiet. Confirm it in one short clause and keep teaching in the same breath — "added — so, back to ephemeral". Never announce that you are about to use a tool, never describe the tool, never read back what it returned. If it tells you a word was already there, say so in passing ("that one's already on your list") and carry on.
- If saving fails, don't retry it and don't dwell on it. Say you couldn't save it right now and keep teaching.`;

const version: PromptVersion = {
  version: "words-2.1",
  provider: "openai",
  // The service is the label on 1.0/2.0/3.0 because the service is all that varies between them.
  // Here it isn't, so the label names the difference — this is the one a learner picks on purpose.
  label: "2.1 · ChatGPT — podcast lesson, saves words",
  prompt: PODCAST_LESSON_PROMPT + SAVE_TO_COLLECTION_CLAUSE,
  /**
   * The whole reason this version exists. One tool, named — there is no wildcard, and the server's
   * one-shared-secret model is why (types.ts).
   */
  mcpTools: ["add_words_to_collection"],
  // Both carried over from words-2.0 unchanged: same lesson, same pacing. See that module for what
  // each one buys, and why three seconds becomes five on this provider.
  turnTimeoutSeconds: 3,
  turnEagerness: "patient",
};

export default version;
