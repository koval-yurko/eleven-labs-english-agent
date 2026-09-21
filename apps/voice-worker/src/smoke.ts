/**
 * The live smoke test docs/2026-09-11-livekit-claude-diy-provider.md §4 L2 asks for: three
 * sequential turns against the real Anthropic API, asserting `cache_read_input_tokens > 0` from
 * turn 2 on. "The test that would have caught #7217 and the hoisting bug" — L2's pure checks
 * (`src/check.ts`) prove the REQUEST is shaped correctly; only a real call proves Anthropic actually
 * reuses the cache across turns the way the shape implies it will.
 *
 * Costs real, billed tokens. Run on demand — `pnpm --filter voice-worker smoke` — never in CI.
 * Requires `ANTHROPIC_API_KEY` in the environment; refuses rather than silently skip.
 */
import "./env.ts";

import process from "node:process";
import { ChatContext, initializeLogger } from "@livekit/agents";

import { ClaudeLLM } from "./claude-llm.ts";

// `llm.LLMStream`'s constructor reaches for the framework's pino logger, which the worker process
// normally sets up on startup (`cli.runApp`). This script isn't a worker — it drives the adapter
// directly — so without this it dies on "logger not initialized" before the first request is sent.
initializeLogger({ pretty: true, level: "warn" });

/**
 * Filler, not the real lesson prompt — `apps/voice-worker` never imports `apps/web`'s prompt
 * registry (§1), and this test exists to prove CACHING mechanics, not to exercise the lesson
 * itself. Sized past Sonnet 5's 1024-token cache minimum (research doc §3.2's table; Haiku 4.5's is
 * 4096 and would silently no-op here) with real margin, since a prompt that sits right at the
 * boundary is exactly the kind of thing that passes today and flakes on a smaller model swap.
 */
const FILLER_PARAGRAPH =
  "You are running a smoke test for a Claude adapter built on top of the LiveKit Agents framework. " +
  "This paragraph exists only to push the system prompt comfortably past the token minimum Claude " +
  "needs before it will create a prompt cache entry at all — Sonnet 5's floor is 1024 tokens, and " +
  "this text is repeated until the whole block clears that by a wide margin, so a result here is " +
  "never a coin flip against the exact boundary. ";
const SYSTEM_PROMPT = FILLER_PARAGRAPH.repeat(40);

const TURNS = [
  "Let's begin. Say hello in one sentence.",
  "Tell me one more short fact, in one sentence.",
  "Wrap up with a one-sentence goodbye.",
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "smoke: ANTHROPIC_API_KEY is not set. This test makes real, billed Claude calls, so it " +
        "refuses to run without one rather than skip silently.",
    );
    process.exit(1);
  }

  const model = new ClaudeLLM({});
  const chatCtx = new ChatContext();
  chatCtx.addMessage({ id: "lk.agent_task.instructions", role: "system", content: SYSTEM_PROMPT });

  for (let i = 0; i < TURNS.length; i++) {
    const turnNumber = i + 1;
    chatCtx.addMessage({ role: "user", content: TURNS[i]! });
    const stream = model.chat({ chatCtx });
    const collected = await stream.collect();
    chatCtx.addMessage({ role: "assistant", content: collected.text });

    const usage = collected.usage;
    console.log(
      `turn ${turnNumber}: input=${usage?.promptTokens ?? "?"} ` +
        `cacheRead=${usage?.promptCachedTokens ?? "?"} cacheWrite=${usage?.cacheCreationTokens ?? "?"} ` +
        `output=${usage?.completionTokens ?? "?"}`,
    );

    // From turn 2 on, the growing history should hit the cache breakpoint the PREVIOUS turn left at
    // the end of `system` (turn 1) or the end of `messages` (turn 2+) — see `applyCacheControl`.
    if (turnNumber >= 2 && (!usage || usage.promptCachedTokens <= 0)) {
      console.error(
        `smoke: FAILED — turn ${turnNumber} shows no cache read (promptCachedTokens=` +
          `${usage?.promptCachedTokens ?? "undefined"}). This is exactly the signal #7217's hoisting ` +
          "bug and a missing cache_control would both produce: a growing prefix that Anthropic never reuses.",
      );
      process.exit(1);
    }
  }

  console.log("smoke: cache reads confirmed from turn 2 onward — the adapter is caching correctly.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
