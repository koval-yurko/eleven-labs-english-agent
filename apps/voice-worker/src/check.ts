/**
 * L2 — the Claude adapter's request builder, pure (docs/2026-09-11-livekit-claude-diy-provider.md
 * §4 L2). No network, no API key: every fixture here is a `ChatItem[]` built directly from
 * `@livekit/agents`' own classes, the same shapes the framework hands `ClaudeLLM.chat()` at runtime.
 * Run with `pnpm --filter voice-worker check`.
 */
import process from "node:process";
import { initializeLogger, ChatMessage, FunctionCall, FunctionCallOutput, type ChatItem } from "@livekit/agents";

import { CONTEXT_NOTE_PREFIX, applyCacheControl, buildAnthropicMessages, buildMessageParams } from "./claude-request.ts";
import { DEFAULT_MODEL } from "./claude-llm.ts";
import { isSilent, tapSpeech, type SpeechOutcome } from "./speech-watch.ts";
import { TurnLedger, type LedgerLlmCall, type LedgerMessage } from "./turn-ledger.ts";
import { TURN_PLANS, turnHandlingFor } from "./turn-plans.ts";
import type { TurnRecord } from "@tutor/shared/tutor/livekit-wire";

import { createTts } from "./pipeline.ts";

const failures: string[] = [];
let checked = 0;

const eq = (label: string, actual: unknown, expected: unknown) => {
  checked += 1;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
};

const ok = (label: string, condition: boolean) => {
  checked += 1;
  if (!condition) failures.push(`${label}: condition failed`);
};

const INSTRUCTIONS_ID = "lk.agent_task.instructions";
const instructions = (text: string) => ChatMessage.create({ id: INSTRUCTIONS_ID, role: "system", content: text });
const user = (text: string) => ChatMessage.create({ role: "user", content: text });
const agent = (text: string) => ChatMessage.create({ role: "assistant", content: text });
const note = (text: string) => ChatMessage.create({ role: "system", content: text });
const call = (callId: string, name = "add_words_to_collection", args = "{}") =>
  FunctionCall.create({ callId, name, args });
const result = (callId: string, output = "ok") => FunctionCallOutput.create({ callId, output, isError: false });

function lastMessage(messages: ReturnType<typeof buildAnthropicMessages>["messages"]) {
  return messages[messages.length - 1];
}

// ── 1. Never ends on an assistant turn ──────────────────────────────────────────────────────────
{
  const cases: { label: string; items: ChatItem[] }[] = [
    { label: "empty context", items: [] },
    { label: "ends on plain assistant text", items: [instructions("sys"), user("hi"), agent("hello")] },
    { label: "ends on an unresolved tool_use", items: [instructions("sys"), user("save it"), call("c1")] },
    { label: "ends on a resolved tool_result (already user role)", items: [user("save it"), call("c1"), result("c1")] },
  ];
  for (const { label, items } of cases) {
    const { messages } = buildAnthropicMessages(items);
    ok(`never-ends-on-assistant: ${label}`, lastMessage(messages)?.role === "user");
  }
}

// ── 2. Never puts a user turn between tool_use and its tool_result ─────────────────────────────
{
  // The pause context arrives WHILE a tool call is in flight — the exact edge case #7217's second
  // trap is about, and the one scenario where a naive item-by-item mapping would fail this.
  const items: ChatItem[] = [
    instructions("sys"),
    user("save 'ubiquitous'"),
    call("c1"),
    note("The learner paused the lesson."), // arrives mid-call
    result("c1"),
  ];
  const { messages } = buildAnthropicMessages(items);
  const toolUseIdx = messages.findIndex(
    (m) => Array.isArray(m.content) && m.content.some((b) => "type" in b && b.type === "tool_use"),
  );
  const nextMsg = messages[toolUseIdx + 1];
  const nextIsToolResult =
    !!nextMsg &&
    Array.isArray(nextMsg.content) &&
    nextMsg.content.some((b) => "type" in b && b.type === "tool_result" && b.tool_use_id === "c1");
  ok("tool_use is immediately followed by its tool_result, not the deferred pause note", nextIsToolResult);
  // The deferred note must still show up somewhere, merged onto that same tool_result message —
  // dropping it silently would be worse than misplacing it.
  const noteText = JSON.stringify(nextMsg?.content);
  ok("the deferred note is not lost — it rides along on the tool_result message", noteText.includes(CONTEXT_NOTE_PREFIX));
}

// ── 3. An unresolved trailing tool_use gets a synthetic tool_result, never a text dummy ────────
{
  const items: ChatItem[] = [instructions("sys"), user("save it"), call("c1", "add_words_to_collection")];
  const { messages } = buildAnthropicMessages(items);
  const last = lastMessage(messages);
  ok(
    "the trailing unresolved tool_use is closed with a tool_result block, not plain text",
    Array.isArray(last?.content) &&
      last.content.length === 1 &&
      "type" in last.content[0]! &&
      last.content[0]!.type === "tool_result" &&
      "tool_use_id" in last.content[0]! &&
      last.content[0]!.tool_use_id === "c1",
  );
}

// ── 4. Context notes become user-role markers, never system — except the leading instructions ──
{
  const items: ChatItem[] = [instructions("You are a tutor."), user("hi"), note("The learner paused."), agent("ok")];
  const { system, messages } = buildAnthropicMessages(items);
  eq("only the leading instructions message becomes `system`", system, [{ type: "text", text: "You are a tutor." }]);
  const noteMessage = messages.find((m) => JSON.stringify(m.content).includes(CONTEXT_NOTE_PREFIX));
  ok("the mid-conversation note became a user-role marker", noteMessage?.role === "user");
  ok(
    "the marker carries the prefix so Claude can tell it apart from the learner's own words",
    JSON.stringify(noteMessage?.content).includes(CONTEXT_NOTE_PREFIX + "The learner paused."),
  );
}

// ── 5. No temperature; thinking.type === "disabled" ─────────────────────────────────────────────
{
  const parts = applyCacheControl(buildAnthropicMessages([instructions("sys"), user("hi")]));
  const params = buildMessageParams({ model: DEFAULT_MODEL, parts, tools: [], toolChoice: undefined });
  eq("thinking is always disabled", params.thinking, { type: "disabled" });
  ok("no temperature is ever sent", !("temperature" in params));
}

// ── 6. Byte-identical tools+system prefix across turns (the cache invariant) ────────────────────
{
  const turnOne = buildAnthropicMessages([instructions("You are a tutor."), user("hi")]);
  const turnFive = buildAnthropicMessages([
    instructions("You are a tutor."),
    user("hi"),
    agent("hello"),
    user("let's continue"),
    agent("sure"),
    user("one more thing"),
  ]);
  eq("the system block is byte-identical no matter how long the history has grown", turnFive.system, turnOne.system);
  const paramsOne = buildMessageParams({ model: DEFAULT_MODEL, parts: turnOne, tools: [], toolChoice: undefined });
  const paramsFive = buildMessageParams({ model: DEFAULT_MODEL, parts: turnFive, tools: [], toolChoice: undefined });
  eq("an unset tools list stays byte-identical too", paramsFive.tools, paramsOne.tools);
}

// ── 7. cache_control lands on exactly the last system block and the last message's last block ──
{
  const raw = buildAnthropicMessages([instructions("sys"), user("hi"), agent("hello"), user("more")]);
  const cached = applyCacheControl(raw);
  ok("cache_control on the last (only) system block", cached.system?.[0]?.cache_control?.type === "ephemeral");
  const lastMsg = lastMessage(cached.messages);
  const lastBlock = Array.isArray(lastMsg?.content) ? lastMsg.content[lastMsg.content.length - 1] : undefined;
  ok(
    "cache_control on the last content block of the last message",
    !!lastBlock && "cache_control" in lastBlock && lastBlock.cache_control?.type === "ephemeral",
  );
  const earlierMsg = cached.messages[0];
  const earlierBlock = Array.isArray(earlierMsg?.content) ? earlierMsg.content[0] : undefined;
  ok(
    "no earlier message gets a breakpoint — only the growing edge does",
    !!earlierBlock && (!("cache_control" in earlierBlock) || !earlierBlock.cache_control),
  );
}

// ── 8. Consecutive same-role items merge into one message with several content blocks ───────────
{
  // Both calls resolved, so the trailing-unresolved fix (§3 above) stays out of the way and this
  // fixture tests only the merge.
  const items: ChatItem[] = [
    instructions("sys"),
    user("save two things"),
    call("c1"),
    call("c2"),
    result("c1"),
    result("c2"),
  ];
  const { messages } = buildAnthropicMessages(items);
  const toolUseMsg = messages.find(
    (m) => Array.isArray(m.content) && m.content.some((b) => "type" in b && b.type === "tool_use"),
  );
  ok(
    "two parallel tool_use blocks merge onto one assistant message, not two",
    toolUseMsg?.role === "assistant" && Array.isArray(toolUseMsg.content) && toolUseMsg.content.length === 2,
  );
  const toolResultMsg = messages.find(
    (m) => Array.isArray(m.content) && m.content.filter((b) => "type" in b && b.type === "tool_result").length === 2,
  );
  ok("their two tool_results likewise merge onto one user message, not two", !!toolResultMsg);
}

// ── Turn ledger (research doc §5.2) ─────────────────────────────────────────────────────────────
{
  const records: TurnRecord[] = [];
  const ledger = new TurnLedger({ model: DEFAULT_MODEL, startedAtMs: 1_000, onRecord: (r) => records.push(r) });
  const llmCall = (requestId: string, over: Partial<LedgerLlmCall> = {}): LedgerLlmCall => ({
    requestId,
    cancelled: false,
    ttftMs: 400,
    promptTokens: 6000,
    promptCachedTokens: 5500,
    cacheCreationTokens: 60,
    completionTokens: 40,
    ...over,
  });
  const msg = (role: LedgerMessage["role"], text: string, over: Partial<LedgerMessage> = {}): LedgerMessage => ({
    role,
    text,
    interrupted: false,
    createdAtMs: 3_500,
    metrics: {},
    ...over,
  });

  // A turn with one discarded preemptive attempt, a barge-in, and a tool call.
  ledger.message(msg("user", "I think the word is", { metrics: { endOfTurnDelay: 0.9, transcriptionDelay: 0.2 } }));
  ledger.llmCall(llmCall("r1", { cancelled: true, promptTokens: 5900, promptCachedTokens: 5500, cacheCreationTokens: 0, completionTokens: 3 }));
  ledger.message(msg("user", "fleeting."));
  ledger.completion("r2", "Yes, fleeting! Now say it in a sentence of your own.");
  ledger.llmCall(llmCall("r2"));
  ledger.toolsExecuted(["add_words_to_collection"]);
  ledger.message(msg("assistant", "Yes, fleeting! Now", { interrupted: true, metrics: { llmNodeTtft: 0.45, ttsNodeTtfb: 0.2, e2eLatency: 1.6 } }));

  const [r] = records;
  eq("ledger: one record per committed tutor message", records.length, 1);
  eq("ledger: consecutive learner messages join into one userText", r?.userText, "I think the word is fleeting.");
  eq("ledger: agentText is what Claude generated, agentHeardText what played", [r?.agentText, r?.agentHeardText], [
    "Yes, fleeting! Now say it in a sentence of your own.",
    "Yes, fleeting! Now",
  ]);
  eq("ledger: a cancelled request counts as a preemptive attempt", r?.preemptiveAttempts, 1);
  eq("ledger: tokens sum every billed request, discarded ones included", [r?.cacheReadTokens, r?.cacheWriteTokens, r?.outputTokens], [11000, 60, 43]);
  eq("ledger: inputTokens is the uncached remainder", r?.inputTokens, 5900 + 6000 - 11000 - 60);
  eq("ledger: learner-side latency comes from the user message, seconds → ms", [r?.endOfTurnDelayMs, r?.transcriptionDelayMs], [900, 200]);
  eq("ledger: tutor-side latency comes from the assistant message", [r?.llmTtftMs, r?.ttsTtfbMs, r?.e2eLatencyMs], [450, 200, 1600]);
  eq("ledger: atSecs is on the lesson clock", r?.atSecs, 2.5);
  eq("ledger: tool calls and the barge-in are recorded", [r?.toolCalls, r?.interrupted], [["add_words_to_collection"], true]);

  // The next turn starts clean: nothing from turn 0 leaks into it.
  ledger.falseInterruption(true);
  ledger.error("stt:APIConnectionError");
  ledger.message(msg("assistant", "Take your time."));
  const next = records[1];
  eq("ledger: seq increments", next?.seq, 1);
  eq("ledger: a turn with no LLM metrics yet has zero tokens and heard text as agentText", [next?.outputTokens, next?.agentText], [0, "Take your time."]);
  eq("ledger: state resets between turns", [next?.userText, next?.toolCalls, next?.preemptiveAttempts], ["", [], 0]);
  eq("ledger: errors and a resumed false interruption land on the turn they happened in", [next?.errors, next?.falseInterruptionResumed], [["stt:APIConnectionError"], true]);
  eq("ledger: a missing metric is -1, never a fake 0", next?.e2eLatencyMs, -1);

  // The turn that never closed (report d2a257ee): Claude answered, the voice returned nothing, so
  // no tutor message was ever committed.
  ledger.flush(9_000);
  eq("ledger: flush with nothing pending writes nothing", records.length, 2);
  ledger.message(msg("user", "Continue."));
  ledger.flush(9_000);
  eq("ledger: a learner line alone is not a turn", records.length, 2);
  ledger.completion("r3", "Let's start with fleeting.");
  ledger.llmCall(llmCall("r3"));
  ledger.error("tts:silent");
  ledger.flush(9_000);
  const unspoken = records[2];
  eq("ledger: flush records the turn that never closed", records.length, 3);
  eq("ledger: the unspoken turn keeps what was generated and says nothing was heard", [unspoken?.agentText, unspoken?.agentHeardText], ["Let's start with fleeting.", ""]);
  eq("ledger: the unspoken turn keeps its error, its tokens and the learner's words", [unspoken?.errors, unspoken?.outputTokens, unspoken?.userText], [["tts:silent"], 40, "Continue."]);
  ledger.flush(9_000);
  eq("ledger: flush is idempotent", records.length, 3);
}

// ── Silent speech (docs/2026-10-02-livekit-silent-tts-on-spent-quota.md) ────────────────────────
{
  async function* from<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) yield item;
  }
  const run = async (text: string[], frames: number[], stopAfter?: number): Promise<SpeechOutcome | null> => {
    let outcome: SpeechOutcome | null = null;
    const tap = tapSpeech((o) => (outcome = o));
    // The TTS node reads all of the text and then yields its frames, as the real one does.
    const audio = tap.audio(
      (async function* () {
        for await (const chunk of tap.text(from(text))) void chunk;
        yield* from(frames);
      })(),
    );
    let seen = 0;
    for await (const frame of audio) {
      void frame;
      seen += 1;
      if (stopAfter !== undefined && seen >= stopAfter) break;
    }
    return outcome;
  };

  const spoken = await run(["Hello ", "there."], [1, 2, 3]);
  eq("speech: text and frames are counted", spoken, { speakableChars: 10, frames: 3 });
  ok("speech: a reply with audio is not silent", spoken !== null && !isSilent(spoken));
  const mute = await run(["Hello there."], []);
  ok("speech: text in and no audio out is silent", mute !== null && isSilent(mute));
  const dots = await run(["… — !"], []);
  ok("speech: punctuation alone producing no audio is not a failure", dots !== null && !isSilent(dots));
  eq("speech: a cancelled synthesis is never judged", await run(["Hello there."], [1, 2, 3], 1), null);
}

// ── Turn-taking presets (research doc §2 Q4) ───────────────────────────────────────────────────
{
  const plans = [TURN_PLANS.eager, TURN_PLANS.normal, TURN_PLANS.patient];
  ok(
    "turn plans: each step from eager to patient waits longer and needs more to interrupt",
    plans.every(
      (p, i) =>
        i === 0 ||
        (p.endpointing.minDelay > plans[i - 1]!.endpointing.minDelay &&
          p.endpointing.maxDelay > plans[i - 1]!.endpointing.maxDelay &&
          p.interruption.minDuration > plans[i - 1]!.interruption.minDuration),
    ),
  );
  ok("turn plans: minDelay < maxDelay in every plan", plans.every((p) => p.endpointing.minDelay < p.endpointing.maxDelay));
  ok("turn plans: values are milliseconds, not the doc's seconds", plans.every((p) => p.endpointing.minDelay >= 100));
  eq("turn plans: a lesson that names no plan is patient", turnHandlingFor(undefined), TURN_PLANS.patient);
}

// The TTS is Deepgram: a voice is a model name, and the lesson's ElevenLabs voice id is not one.
{
  const key = process.env.DEEPGRAM_API_KEY;
  try {
    initializeLogger({ pretty: false, level: "error" });
    process.env.DEEPGRAM_API_KEY = "offline-regression-key";
    ok("TTS builds on the Deepgram key", Boolean(createTts()));
  } finally {
    if (key === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = key;
  }
}

console.log(`checked ${checked} voice-worker properties`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length}`);
  console.error(failures.join("\n---\n"));
  process.exit(1);
}
console.log("voice-worker request builder, ledger and turn plans: all properties hold");
