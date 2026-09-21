/**
 * Turns a LiveKit `ChatContext` into an Anthropic Messages request — the part of our own Claude
 * adapter that has to be a PURE function, so its invariants can be property-checked without a
 * network call (`src/check.ts`, docs/2026-09-11-livekit-claude-diy-provider.md §4 L2).
 *
 * This replaces `@livekit/agents-plugin-anthropic`, not wraps it: that plugin's `_buildAnthropicContext`
 * (read from its 1.9.0 source while writing this) has exactly the two bugs the research doc's §3.2
 * names, and both are fixed here rather than patched:
 *
 *   1. It pushes EVERY `system`/`developer`-role item into the top-level `system` array, wherever it
 *      occurs — so a mid-lesson `context()` note (which the pause logic sends as such a role) moves
 *      to the FRONT of the prompt, loses when it happened, and invalidates the whole history cache on
 *      every pause. Only a system/developer item that is still genuinely LEADING — nothing else has
 *      been added to the conversation yet, which in practice means `voice/generation.js`'s own
 *      `agent.instructions` message, unshifted once at position 0 — is legitimate system content
 *      here. Anything else with that role becomes a user-role marker IN PLACE.
 *   2. It appends a blind `{role: "user", content: "."}` whenever the context ends on an assistant
 *      turn — including one that ends on an UNRESOLVED `tool_use`, where Anthropic requires the next
 *      message to carry that tool's `tool_result`, not arbitrary text. Sending "." there is rejected
 *      as the same non-retryable 400 this whole adapter exists to avoid (livekit/agents#7217's
 *      "second trap"). This builder appends a synthetic `tool_result` for each open call instead.
 */
import type { ChatItem } from "@livekit/agents";
import type Anthropic from "@anthropic-ai/sdk";

/** How a context/system note that is NOT the leading instructions is marked, so Claude can tell it
 *  apart from the learner's own words without it ever being mistaken for a system directive. */
export const CONTEXT_NOTE_PREFIX = "[lesson app] ";

/** What opens the turn when the history is empty or starts on the wrong role. Anthropic requires
 *  the first message to be `user`; nothing upstream of this builder guarantees that. */
const OPENING_PLACEHOLDER = "(start)";

/** What closes the turn when it would otherwise end on assistant text with no open tool call —
 *  Claude 4.6+ does not support assistant-turn prefill, so ending there is a non-retryable 400. */
const CONTINUATION_PLACEHOLDER = "(continue)";

type RawMessage = { role: "user" | "assistant"; content: Anthropic.ContentBlockParam[] };

export interface AnthropicRequestParts {
  system: Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
}

/**
 * Build the `system` and `messages` Anthropic will accept from a LiveKit chat context — in one
 * pass, in order, never reordering an item relative to another of the same disposition.
 */
export function buildAnthropicMessages(items: readonly ChatItem[]): AnthropicRequestParts {
  const system: Anthropic.TextBlockParam[] = [];
  const raw: RawMessage[] = [];
  /** Notes held back because they arrived while the most recent tool call had no result yet —
   *  flushed the instant that result appears, so they never land BETWEEN a `tool_use` and its
   *  `tool_result` (L2's second invariant). Anthropic requires the two adjacent. */
  let pendingNotes: string[] = [];
  let openToolUseId: string | undefined;

  const pushText = (role: "user" | "assistant", text: string) => {
    raw.push({ role, content: [{ type: "text", text }] });
  };

  for (const item of items) {
    if (item.type === "message") {
      const text = item.rawTextContent ?? "";
      if (item.role === "system" || item.role === "developer") {
        // Still genuinely leading: nothing else has entered the conversation yet, so this is
        // `agent.instructions` (or something else stacked ahead of the first turn), not a note
        // arriving mid-lesson. `raw.length === 0` implies no tool call is open either.
        if (raw.length === 0) {
          system.push({ type: "text", text });
          continue;
        }
        const note = CONTEXT_NOTE_PREFIX + text;
        if (openToolUseId !== undefined) {
          pendingNotes.push(note);
        } else {
          pushText("user", note);
        }
        continue;
      }
      if (item.role === "user" || item.role === "assistant") {
        pushText(item.role, text);
      }
      continue;
    }
    if (item.type === "function_call") {
      raw.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: item.callId,
            name: item.name,
            input: item.args ? (JSON.parse(item.args) as Record<string, unknown>) : {},
          },
        ],
      });
      openToolUseId = item.callId;
      continue;
    }
    if (item.type === "function_call_output") {
      raw.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: item.callId,
            content: item.output,
            is_error: item.isError,
          },
        ],
      });
      if (item.callId === openToolUseId) openToolUseId = undefined;
      for (const note of pendingNotes) pushText("user", note);
      pendingNotes = [];
      continue;
    }
    // AgentHandoffItem, AgentConfigUpdate: no Anthropic-side representation. Skipped, not errored —
    // a multi-agent handoff is not a concept this single-agent lesson uses (Phase 1).
  }
  // A note that arrived after the last tool call closed, or that never saw one open, is still
  // pending only if the loop ended before any later item could flush it (i.e. it's the very last
  // thing in the context). Flush in original order rather than drop it.
  for (const note of pendingNotes) pushText("user", note);

  const messages = mergeConsecutiveSameRole(raw);
  ensureOpensOnUser(messages);
  closeTrailingAssistantTurn(messages);

  return { system: system.length > 0 ? system : undefined, messages };
}

/** Anthropic requires strictly alternating roles; the loop above can emit runs (e.g. two
 *  `function_call`s in a row for parallel tool calls, or two notes in a row). Merge them into one
 *  message with multiple content blocks — never drop a block, never reorder one. */
function mergeConsecutiveSameRole(raw: RawMessage[]): Anthropic.MessageParam[] {
  const merged: Anthropic.MessageParam[] = [];
  for (const msg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      const prevContent = prev.content as Anthropic.ContentBlockParam[];
      prev.content = [...prevContent, ...msg.content];
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }
  return merged;
}

function ensureOpensOnUser(messages: Anthropic.MessageParam[]): void {
  if (messages.length === 0 || messages[0]?.role !== "user") {
    messages.unshift({ role: "user", content: OPENING_PLACEHOLDER });
  }
}

/**
 * Never end on an assistant turn (L2's first invariant) — but an assistant turn that ends on an
 * UNRESOLVED `tool_use` must be closed with that tool's `tool_result`, never a text placeholder
 * (L2's second invariant, and the #7217 trap the plugin falls into). Every open call gets a
 * synthetic error result: whatever left it unresolved (an interruption, a crash) means it did not
 * actually run, and Claude should be told that rather than told nothing.
 */
function closeTrailingAssistantTurn(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return;
  const content = Array.isArray(last.content) ? last.content : [];
  const openToolUses = content.filter(
    (block): block is Anthropic.ToolUseBlockParam =>
      typeof block === "object" && block !== null && "type" in block && block.type === "tool_use",
  );
  if (openToolUses.length > 0) {
    messages.push({
      role: "user",
      content: openToolUses.map(
        (tu): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "The lesson moved on before this tool call finished.",
          is_error: true,
        }),
      ),
    });
    return;
  }
  messages.push({ role: "user", content: CONTINUATION_PLACEHOLDER });
}

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Assemble the final request Anthropic will see, from parts already built by
 * `buildAnthropicMessages`/`applyCacheControl`. Pure — no network, no client — so the five L2
 * invariants (docs/2026-09-11-livekit-claude-diy-provider.md §4 L2) can be checked against its
 * output directly: no `temperature` ever appears, `thinking.type` is always `"disabled"`, and the
 * `tools`/`system` prefix is byte-identical across calls that pass the same tools and parts.
 */
export function buildMessageParams(options: {
  model: string;
  parts: AnthropicRequestParts;
  tools: Anthropic.Tool[];
  toolChoice: Anthropic.ToolChoice | undefined;
}): Anthropic.MessageCreateParamsStreaming {
  return {
    model: options.model,
    system: options.parts.system,
    messages: options.parts.messages,
    tools: options.tools.length > 0 ? options.tools : undefined,
    tool_choice: options.toolChoice,
    // Always disabled, always sent, never a `temperature` beside it — see claude-llm.ts's docblock
    // for why both are unconditional rather than options someone could set back.
    thinking: { type: "disabled" },
    stream: true,
    max_tokens: DEFAULT_MAX_TOKENS,
  };
}

/**
 * Apply the two `cache_control` breakpoints our own adapter is responsible for (research doc §3.2):
 * one at the end of `system` (the ~2.9k-token template + items list, byte-identical every turn of a
 * lesson) and one at the end of `messages` (so the breakpoint follows the growing history — Anthropic
 * matches the longest cached prefix, and today's last block is a prefix of tomorrow's).
 * `@livekit/agents-plugin-anthropic` 1.9.0 has no `cache_control` anywhere in its source; this is the
 * whole fix for that half of §3.2.
 */
export function applyCacheControl(parts: AnthropicRequestParts): AnthropicRequestParts {
  const system = parts.system?.map((block, i, arr) =>
    i === arr.length - 1 ? { ...block, cache_control: { type: "ephemeral" as const } } : block,
  );
  const messages = parts.messages.map((msg, i, arr) => {
    if (i !== arr.length - 1) return msg;
    const content = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: msg.content }];
    if (content.length === 0) return msg;
    const lastIdx = content.length - 1;
    return {
      ...msg,
      content: content.map((block, j) =>
        j === lastIdx ? { ...block, cache_control: { type: "ephemeral" as const } } : block,
      ),
    };
  });
  return { system, messages };
}
