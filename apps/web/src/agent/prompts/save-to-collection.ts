/**
 * The clause that turns a podcast lesson into one where the learner can say "save that one".
 *
 * A module of its own for the same reason `./podcast-lesson.ts` is: **two versions on two services
 * run this text byte for byte**, and the only way that comparison keeps meaning anything is if
 * neither of them owns the words. `words-2.1` (OpenAI) had it first and `words-1.1` (ElevenLabs) is
 * the twin; a copy-paste between them would drift into two different lessons the first time either
 * one is improved, and nothing would report it.
 *
 * The tool it describes is the same tool on both — `add_words_to_collection` on our own
 * `/api/mcp` — reached through two very different mechanisms (a minted OpenAI session versus a
 * provisioned ElevenLabs workspace registration). That difference is entirely below the prompt,
 * which is why the prompt does not mention it.
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
 * learner's collection. That is the thing to fix before either of these versions is offered to a
 * second person, and it is a property of the SERVER, not of this text.
 */

/**
 * Appended AFTER the lesson prompt, so the lesson is read first and the tool is an affordance
 * inside a lesson rather than the first thing the model learns about its job.
 *
 * Worded as an interruption rule on purpose: interruptions are already how the learner takes part
 * in this lesson ("Handling interruptions and follow-ups — THIS IS HOW THE LEARNER TAKES PART"), so
 * "save that one" is a new kind of request in a mechanism the prompt has already established,
 * instead of a new mechanism.
 */
export const SAVE_TO_COLLECTION_CLAUSE = `

Saving words to the learner's collection:
- You have one tool, add_words_to_collection, which puts English words or phrases into the learner's vocabulary collection so they can practise them in a later session.
- Use it ONLY when the learner asks you to — "save that one", "add that to my list", "I want to keep 'break the ice'". Never save anything they didn't ask for, and never save the items in today's list: those are already in their collection, which is where today's lesson came from.
- If they ask for something vague ("save that"), save the item or phrase you were just talking about. If it's genuinely unclear which one they mean, ask once, briefly.
- Saving is quiet. Confirm it in one short clause and keep teaching in the same breath — "added — so, back to ephemeral". Never announce that you are about to use a tool, never describe the tool, never read back what it returned. If it tells you a word was already there, say so in passing ("that one's already on your list") and carry on.
- If saving fails, don't retry it and don't dwell on it. Say you couldn't save it right now and keep teaching.`;

/**
 * The tools a version granting this clause must name in `mcpTools`.
 *
 * Beside the text rather than typed out in each version, because the prompt and the grant are one
 * decision: a version carrying the clause without the grant is a tutor promising something it
 * cannot do, and the grant without the clause is a capability nothing tells it about. There is
 * still no wildcard anywhere — this is a literal list, and adding to it is a deliberate edit that
 * changes both versions at once.
 */
export const SAVE_TO_COLLECTION_TOOLS = ["add_words_to_collection"];
