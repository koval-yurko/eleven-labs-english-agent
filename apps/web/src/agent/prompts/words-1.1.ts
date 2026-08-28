/**
 * words-1.1 — the podcast lesson on ElevenLabs, with the collection open to the tutor.
 *
 * `words-1.0` plus one capability, and the exact same capability `words-2.1` added to `words-2.0`:
 * the learner can ask for a word to be saved and the tutor saves it, by calling
 * `add_words_to_collection` on our own MCP server (`/api/mcp`).
 *
 * ## The mechanism is completely different, and none of it is in this file
 *
 * On OpenAI the grant is a per-session object minted by the token route. Here it is a **provisioned
 * workspace resource**: `pnpm sync:agents` registers the MCP server once, records its id in
 * `agents.lock.json`, and PATCHes this version's agent with
 * `conversation_config.agent.prompt.mcp_server_ids`. ElevenLabs then dials `/api/mcp` from their own
 * network on every tool call. See ../elevenlabs-mcp.ts for the translation and
 * docs/2026-08-28-elevenlabs-mcp-in-code.md for why it is shaped this way.
 *
 * The consequence worth knowing while reading `mcpTools` below: **ElevenLabs grants at the SERVER,
 * not at the tool.** This list still narrows what the tutor may reach, but it does so by naming
 * which registration the agent is attached to, not by being sent to ElevenLabs as an allowlist.
 * Two versions granting the same set share one registration; a different set would need its own.
 *
 * ## Why a new version rather than an edit to 1.0
 *
 * Same argument as 2.1's, unchanged: `words-1.0`, `words-2.0` and `words-3.0` are the same prompt
 * BYTE FOR BYTE on three services, and that identity is the only reason comparing them means
 * anything. Adding a clause to `words-1.0` would spend it.
 *
 * What this version buys that 2.1 could not: **the same lesson, the same clause and the same grant,
 * on two services** — so a difference between 1.1 and 2.1 is a difference between ElevenLabs and
 * OpenAI, and nothing else.
 */
import { PODCAST_LESSON_PROMPT } from "./podcast-lesson";
import { SAVE_TO_COLLECTION_CLAUSE, SAVE_TO_COLLECTION_TOOLS } from "./save-to-collection";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  version: "words-1.1",
  provider: "elevenlabs",
  // 1.0/2.0/3.0 name their service because the service is all that varies between them. Here it
  // isn't — 1.1 differs from 1.0 by a capability — so the label names that, the way 2.1's does.
  label: "1.1 · ElevenLabs — podcast lesson, saves words",
  prompt: PODCAST_LESSON_PROMPT + SAVE_TO_COLLECTION_CLAUSE,
  /** The grant. Shared with words-2.1 so the prompt clause and the tool list stay one decision. */
  mcpTools: SAVE_TO_COLLECTION_TOOLS,
  // Everything below is words-1.0's config, carried over unchanged so that the capability is the
  // only difference between the two. See that module for what each value buys.
  ttsModelId: "eleven_v3_conversational",
  additionalLanguages: ["ru"],
  turnTimeoutSeconds: 3,
  turnEagerness: "patient",
};

export default version;
