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
 * from ./save-to-collection.ts. Diffing 2.0 against 2.1 shows exactly one thing, which is the point.
 *
 * ## Its twin
 *
 * `words-1.1` is this version on ElevenLabs — same lesson, same clause, same grant, and the whole
 * difference is which service runs it and how the tool reaches the model. The clause and the tool
 * list moved out of this file into ./save-to-collection.ts when that twin was written, so the two
 * cannot drift; what each version still states for itself is its provider and its pacing.
 */
import { PODCAST_LESSON_PROMPT } from "./podcast-lesson";
import { SAVE_TO_COLLECTION_CLAUSE, SAVE_TO_COLLECTION_TOOLS } from "./save-to-collection";
import type { PromptVersion } from "./types";

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
  mcpTools: SAVE_TO_COLLECTION_TOOLS,
  // Both carried over from words-2.0 unchanged: same lesson, same pacing. See that module for what
  // each one buys, and why three seconds becomes five on this provider.
  turnTimeoutSeconds: 3,
  turnEagerness: "patient",
};

export default version;
