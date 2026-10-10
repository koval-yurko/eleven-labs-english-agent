/**
 * words-3.1 — the podcast lesson on Vapi, with the collection open to the tutor.
 *
 * `words-3.0` plus one capability, and the same capability `words-1.1` and `words-2.1` added to their
 * own twins: the learner can ask for a word to be saved and the tutor saves it, by calling
 * `add_words_to_collection` on our own MCP server (`/api/mcp`).
 *
 * With this module the trio is complete. **The same lesson, the same clause and the same grant now
 * run on all three services** — so a difference between 1.1, 2.1 and 3.1 is a difference between
 * ElevenLabs, OpenAI and Vapi, and nothing else. That is what 1.0 / 2.0 / 3.0 are for the lesson
 * without the tool, and it is the only reason any of these comparisons mean anything.
 *
 * ## The third mechanism, and none of it is in this file
 *
 * On OpenAI the grant is a per-session object minted by the token route. On ElevenLabs it is a
 * provisioned workspace registration the agent names by id. Here it is neither: it is a FIELD OF THE
 * ASSISTANT — one `model.tools` entry of `type: "mcp"`, carried by the same create/patch that carries
 * the prompt, with no second remote object and nothing in the lockfile. See ../vapi-mcp.ts for the
 * translation and docs/2026-09-10-vapi-mcp-on-the-third-provider.md for why it is shaped this way.
 *
 * Two consequences worth knowing while reading `mcpTools` below:
 *
 *   - **Vapi grants at the SERVER, one step coarser even than ElevenLabs.** There is no allowlist
 *     field anywhere in Vapi's MCP tool; it fetches the tool list when the call starts and hands the
 *     model everything `/api/mcp` advertises. So this list does not narrow anything on this provider
 *     — it switches the grant on, and it documents what the lesson expects to find. The day a second
 *     tool is registered on our server, this version gets it. (`prompts/types.ts` says so too.)
 *   - **This is the one provider that holds `MCP_TOKEN` itself.** ElevenLabs keeps it in a workspace
 *     secret and OpenAI is handed it per session; Vapi has no secret store, so `pnpm sync:agents`
 *     writes the header into this version's assistant. Rotating the token therefore means re-running
 *     the sync, and running the sync without the token skips the provider rather than breaking it.
 *
 * ## Why a new version rather than an edit to 3.0
 *
 * Same argument as 1.1's and 2.1's, unchanged: `words-1.0`, `words-2.0` and `words-3.0` are the same
 * prompt BYTE FOR BYTE on three services, and that identity is the only reason comparing them means
 * anything. Appending a clause to `words-3.0` would spend it — and setting `mcpTools` there without
 * the clause would change what 3.0 does while leaving its module claiming otherwise.
 *
 * The prompt is therefore composed, not copied: `PODCAST_LESSON_PROMPT` unchanged, plus the clause
 * from ./save-to-collection.ts, which all three of these versions share so that they cannot drift.
 */
import { PODCAST_LESSON_PROMPT } from "./podcast-lesson";
import { SAVE_TO_COLLECTION_CLAUSE, SAVE_TO_COLLECTION_TOOLS } from "./save-to-collection";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  version: "words-3.1",
  provider: "vapi",
  // 1.0/2.0/3.0 name their service because the service is all that varies between them. Here it
  // isn't — 3.1 differs from 3.0 by a capability — so the label names that, as 1.1's and 2.1's do.
  label: "3.1 · Vapi — podcast lesson, saves words",
  prompt: PODCAST_LESSON_PROMPT + SAVE_TO_COLLECTION_CLAUSE,
  /** The grant. Shared with words-1.1 and words-2.1 so the clause and the tool list stay one decision. */
  mcpTools: SAVE_TO_COLLECTION_TOOLS,
  // Everything below is words-3.0's config, carried over unchanged so that the capability is the
  // only difference between the two. See that module for what each value buys — including why
  // `turnTimeoutSeconds` is absent here while its two twins pin 3 s.
  llm: "claude-sonnet-4-6",
  turnEagerness: "patient",
  silenceEndCallTimeoutSeconds: -1,
};

export default version;
