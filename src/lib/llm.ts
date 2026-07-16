import { ChatAnthropic } from "@langchain/anthropic";

/**
 * LangChain + Anthropic (Claude) example. SERVER-ONLY — ANTHROPIC_API_KEY never reaches the
 * browser. When LANGSMITH_API_KEY / LANGCHAIN_TRACING_V2 are set, LangChain auto-traces every
 * `.invoke()` to LangSmith (no extra wiring) — see the langsmith-* skills.
 */

// Default to the latest, most capable Claude model. Override with ANTHROPIC_MODEL.
const DEFAULT_MODEL = "claude-opus-4-5";

export function hasAnthropicEnv(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Deliberately no `temperature` / `top_p` / `top_k` override: they're removed on opus-4-8/4-7,
 * sonnet-5, and fable-5 (400), while still working on the opus-4-5 default below — so adding one
 * passes here and breaks the moment ANTHROPIC_MODEL moves. Steer with the prompt instead.
 */
export function getChatModel(overrides?: { maxTokens?: number }): ChatAnthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  return new ChatAnthropic({
    apiKey,
    model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    maxTokens: 1024,
    ...overrides,
    // @langchain/anthropic@0.3.x defaults top_p/top_k to the sentinel -1 and only strips it
    // for a hardcoded model allowlist that predates claude-opus-4-8 — so it sends `top_p: -1`,
    // which newer models reject ("`top_p` cannot be set to -1"). invocationKwargs is spread
    // last into the request body, so undefined overrides the sentinel and is dropped from JSON.
    invocationKwargs: { top_p: undefined, top_k: undefined },
  });
}

/** Ask Claude a single question and return its text answer. */
export async function askClaude(prompt: string): Promise<string> {
  const res = await getChatModel().invoke(prompt);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}
