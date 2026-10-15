/**
 * L2 — the Claude adapter's request builder, pure (docs/2026-09-11-livekit-claude-diy-provider.md
 * §4 L2). No network, no API key: every fixture here is a `ChatItem[]` built directly from
 * `@livekit/agents`' own classes, the same shapes the framework hands `ClaudeLLM.chat()` at runtime.
 * Run with `pnpm --filter voice-worker check`.
 */
import process from "node:process";
import { initializeLogger, ChatMessage, FunctionCall, FunctionCallOutput, type ChatItem } from "@livekit/agents";

import { CONTEXT_NOTE_PREFIX, applyCacheControl, buildAnthropicMessages, buildMessageParams, thinkingFor } from "./claude-request.ts";
import { DEFAULT_MODEL } from "./claude-llm.ts";
import { isSilent, tapSpeech, type SpeechOutcome } from "./speech-watch.ts";
import { TurnLedger, type LedgerLlmCall, type LedgerMessage } from "./turn-ledger.ts";
import { TURN_PLANS, turnHandlingFor } from "./turn-plans.ts";
import type { TurnRecord } from "@tutor/shared/tutor/livekit-wire";

import { WebSocketServer, WebSocket as WsClient } from "ws";
import { AutoContinue } from "./auto-continue.ts";
import { Pacer } from "./pacer.ts";
import { SocketPool } from "./qwen-socket-pool.ts";
import { MAX_PIECE_CHARS, MIN_PIECE_CHARS, segment } from "./speech-segments.ts";
import { createTtsFor, missingSecrets, resolveTtsProfile, TTS_PROFILES } from "./tts-profiles.ts";

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
  eq("thinking is off for Sonnet 5 (disabled)", thinkingFor("claude-sonnet-5"), { type: "disabled" });
  eq("thinking is off for Sonnet 5.5 (between_tools: it rejects disabled)", thinkingFor("claude-sonnet-5-5"), { type: "between_tools" });
  eq("buildMessageParams uses the model's spelling", params.thinking, thinkingFor(params.model));
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

// Segmenter: streaming text becomes sentence-sized pieces, none above the cap, nothing lost.
{
  const text = "Hello there, welcome back to the lesson. Today we have five items about law and rules. Let's start with legal bills, which means the money you owe for lawyers.";
  const mid = segment(text, false);
  ok("segments: a sentence shorter than the minimum waits for more text", segment("Hi there. ", false).pieces.length === 0);
  ok("segments: pieces close at a sentence end past the minimum", mid.pieces.every((p) => p.length >= MIN_PIECE_CHARS && /[.!?]\s$/.test(p)));
  eq("segments: nothing is lost across a final flush", segment(text, true).pieces.join(""), text);
  const run = "word ".repeat(200);
  const long = segment(run, true);
  ok("segments: a run with no sentence end is still cut under the cap", long.pieces.length > 1 && long.pieces.every((p) => p.length <= MAX_PIECE_CHARS));
  eq("segments: a long run loses nothing", long.pieces.join(""), run);
  eq("segments: Cyrillic sentences split too", segment("Это первое предложение, довольно длинное для теста. А это второе предложение, тоже длинное. ", false).pieces.length >= 1, true);
}

// Socket pool, against a local server: warm sockets are handed out once, expire, renew, and a server
// that hangs up on a parked socket is noticed.
{
  const server = new WebSocketServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const serverSide: WsClient[] = [];
  server.on("connection", (ws) => serverSide.push(ws as unknown as WsClient));
  let opened = 0;
  const open = () =>
    new Promise<WsClient>((resolve, reject) => {
      opened += 1;
      const ws = new WsClient(`ws://127.0.0.1:${port}`);
      ws.on("error", () => undefined);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const pool = new SocketPool(open, 80);
  pool.warm();
  pool.warm(); // a second call while one is opening must not open another
  const first = await pool.take();
  eq("pool: a warm-up under way is awaited and handed out as reused", first.reused, true);
  eq("pool: taking a socket starts the replacement at once (2 opened)", opened, 2);
  const second = await pool.take();
  eq("pool: the replacement is ready for an overlapping reply", second.reused, true);
  await settle(20);
  const alone = new SocketPool(open, 5000);
  const fresh = await alone.take();
  eq("pool: with nothing parked a fresh socket is opened", fresh.reused, false);
  alone.give(fresh.ws);
  alone.closeAll();
  pool.give(first.ws);
  pool.give(second.ws);
  await settle(20);
  ok("pool: returned sockets are parked, at most two", pool.idleCount >= 1 && pool.idleCount <= 2);
  const again = await pool.take();
  ok("pool: a returned socket comes back reused", again.reused && (again.ws === first.ws || again.ws === second.ws));
  await settle(250);
  ok("pool: idle sockets are retired and renewed, never piling up", pool.idleCount <= 2 && opened >= 4);
  for (const s of serverSide) s.close();
  await settle(60);
  eq("pool: parked sockets the server closed are forgotten", pool.idleCount, 0);
  pool.closeAll();
  const before = opened;
  pool.warm();
  await settle(30);
  eq("pool: a closed pool opens nothing", opened, before);
  server.close();
}

// Auto-continue. Two moves — queue the next chunk behind the one playing (prefetch), or ask for it a
// beat after one ends (fallback) — and the many reasons not to make either.
{
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  interface Fake { interrupted: boolean; interrupt(): void }
  const mk = (): Fake => ({ interrupted: false, interrupt() { this.interrupted = true; } });
  let busy = false;
  let learnerTalking = false;
  const fired: Array<string | undefined> = [];
  const replies: Fake[] = [];
  const make = (over: Partial<ConstructorParameters<typeof AutoContinue>[0]> = {}) =>
    new AutoContinue({
      delayMs: 20, resumeDelayMs: 40, maxRun: 60,
      fire: (previous) => { fired.push(previous); const r = mk(); replies.push(r); return r; },
      canFire: () => !busy,
      canPrefetch: () => !learnerTalking,
      ...over,
    });
  const reset = () => { fired.length = 0; replies.length = 0; busy = false; learnerTalking = false; };

  // — prefetch —
  reset();
  let ac = make();
  ac.turnWritten("chunk one", 0);
  eq("prefetch: a turn's text being written queues the next chunk behind it, handing over that text", fired, ["chunk one"]);
  ac.turnWritten("chunk two", 0);
  eq("prefetch: only one chunk is ever queued ahead", fired.length, 1);
  ac.speechEnded(true, undefined); // the kickoff reply ends: our first chunk is now what plays
  eq("prefetch: when the playing reply ends, the next one is queued behind the new current", fired, ["chunk one", "chunk two"]);
  ac.speechEnded(true, replies[0]);
  eq("prefetch: ...and a finished queued reply promotes the next, which queues another", fired.length, 2);
  await settle(60);
  eq("prefetch: nothing falls back to the timer while a chunk is queued", fired.length, 2);
  ac.dispose();

  reset();
  ac = make();
  ac.turnWritten("a", 0);
  ac.learnerSpoke();
  eq("prefetch: the learner speaking interrupts the queued chunk", replies[0]!.interrupted, true);
  ac.turnWritten("b", 0);
  eq("prefetch: ...and the run restarts", fired.length, 2);
  ac.cancelled();
  eq("prefetch: a turn the phone cancelled drops the queued chunk too", replies[1]!.interrupted, true);
  ac.turnWritten("c", 0);
  ac.speechStarted();
  eq("prefetch: a reply of someone else's beginning drops it", replies[2]!.interrupted, true);
  reset();
  ac.turnWritten("t", 1);
  eq("prefetch: a turn that ended in a tool call is not prefetched past", fired.length, 0);
  learnerTalking = true;
  ac.turnWritten("t", 0);
  eq("prefetch: not while the learner is speaking", fired.length, 0);
  learnerTalking = false;
  ac.hold();
  ac.turnWritten("t", 0);
  eq("prefetch: not while held", fired.length, 0);
  ac.release();
  ac.dispose();

  reset();
  ac = make();
  ac.turnWritten("a", 0);
  ac.complete();
  eq("prefetch: lesson_complete drops the queued chunk", replies[0]!.interrupted, true);
  ac.turnWritten("b", 0);
  eq("prefetch: ...and nothing more is queued", fired.length, 1);
  ac.dispose();

  // lesson_complete is called from INSIDE the reply that is speaking the goodbye: it must not be cut.
  reset();
  ac = make();
  ac.turnWritten("a", 0);
  ac.speechEnded(true, undefined); // the reply before ends: chunk a is what plays now
  ac.turnWritten("b", 0); // queued behind it
  ac.complete();
  eq("prefetch: lesson_complete spares the reply that is speaking the goodbye", replies[0]!.interrupted, false);
  eq("prefetch: ...and drops the one queued behind it", replies[1]!.interrupted, true);
  ac.dispose();

  reset();
  const capped = make({ maxRun: 2 });
  capped.turnWritten("1", 0);
  capped.speechEnded(true, replies[0]);
  capped.turnWritten("2", 0);
  capped.speechEnded(true, replies[1]);
  capped.turnWritten("3", 0);
  eq("prefetch: stops after maxRun chunks in a row", fired.length, 2);
  capped.learnerSpoke();
  capped.turnWritten("4", 0);
  eq("prefetch: the learner speaking resets the run", fired.length, 3);
  capped.dispose();

  reset();
  const noPre = make({ prefetch: false });
  noPre.turnWritten("x", 0);
  eq("prefetch: switched off, a written turn queues nothing", fired.length, 0);
  noPre.dispose();

  // — fallback: the beat after a chunk ends, when nothing was queued —
  reset();
  ac = make({ prefetch: false });
  ac.speechEnded(true);
  await settle(60);
  eq("fallback: a chunk that ended on its own is followed by one request", fired.length, 1);
  ac.speechEnded(false);
  await settle(60);
  eq("fallback: a chunk that was cut is not", fired.length, 1);
  ac.speechEnded(true);
  ac.learnerSpoke();
  await settle(60);
  eq("fallback: the learner speaking inside the beat cancels it", fired.length, 1);
  ac.speechEnded(true);
  ac.speechStarted();
  await settle(60);
  eq("fallback: a reply starting inside the beat cancels it", fired.length, 1);
  busy = true;
  ac.speechEnded(true);
  await settle(60);
  eq("fallback: a busy session is left alone when the beat lands", fired.length, 1);
  busy = false;
  ac.hold();
  ac.speechEnded(true);
  await settle(60);
  eq("fallback: nothing is asked for while the lesson is held", fired.length, 1);
  ac.release();
  await settle(25);
  eq("fallback: a release waits longer than a normal beat, so the phone's own resume wins", fired.length, 1);
  await settle(40);
  eq("fallback: ...and then carries on", fired.length, 2);
  ac.complete();
  ac.speechEnded(true);
  await settle(60);
  eq("fallback: after lesson_complete nothing more is asked for", fired.length, 2);
  ac.dispose();
}

// Pacer: synthesis stays a bounded distance ahead of playback, in order, and an aborted chunk leaves.
{
  const never = new AbortController().signal;
  const pacer = new Pacer(100);
  const t0 = Date.now();
  const waits = await Promise.all([pacer.admit(never, 0.06), pacer.admit(never, 0.06), pacer.admit(never, 0.06), pacer.admit(never, 0.06)]);
  ok("pacer: the first two chunks are admitted at once", waits[0]! < 15 && waits[1]! < 15);
  ok("pacer: later chunks wait for playback to catch up", waits[3]! >= 15);
  ok("pacer: waiting is bounded by the audio queued, not unbounded", Date.now() - t0 < 400);
  const slow = new Pacer(10);
  await slow.admit(never, 5); // five seconds queued, 10 ms allowed
  const gone = new AbortController();
  const pending = slow.admit(gone.signal, 1);
  setTimeout(() => gone.abort(), 20);
  eq("pacer: an aborted waiter leaves the line with -1", await pending, -1);
  slow.reset();
  ok("pacer: after a reset the next chunk is admitted immediately", (await slow.admit(never, 1)) < 15);
  const settled = new Pacer(10);
  await settled.admit(never, 5);
  settled.settle(5, 0);
  ok("pacer: a failed chunk gives its estimate back", settled.aheadMs < 50);
}

// TTS profiles: a version names one; an unknown name falls back; a missing key is named, not silent.
{
  const saved = { ...process.env };
  try {
    initializeLogger({ pretty: false, level: "error" });
    eq("tts: no profile named means Deepgram", resolveTtsProfile(undefined).id, "deepgram");
    eq("tts: an unknown profile falls back, flagged", [resolveTtsProfile("nope").id, resolveTtsProfile("nope").fellBack], ["deepgram", true]);
    eq("tts: a known profile is not a fallback", [resolveTtsProfile("qwen").id, resolveTtsProfile("qwen").fellBack], ["qwen", false]);
    for (const name of ["DEEPGRAM_API_KEY", "DASHSCOPE_API_KEY", "QWEN_WORKSPACE_ID"]) delete process.env[name];
    eq("tts: qwen without keys names both", missingSecrets(TTS_PROFILES.qwen!), ["DASHSCOPE_API_KEY", "QWEN_WORKSPACE_ID"]);
    let message = "";
    try {
      createTtsFor("qwen");
    } catch (error) {
      message = (error as Error).message;
    }
    ok("tts: a profile without its key refuses to build, naming the variable", message.includes("DASHSCOPE_API_KEY"));
    Object.assign(process.env, {
      DEEPGRAM_API_KEY: "offline",
      DASHSCOPE_API_KEY: "offline",
      QWEN_WORKSPACE_ID: "ws-offline",
    });
    for (const id of Object.keys(TTS_PROFILES)) ok(`tts: ${id} builds on its keys`, Boolean(createTtsFor(id)));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

console.log(`checked ${checked} voice-worker properties`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length}`);
  console.error(failures.join("\n---\n"));
  process.exit(1);
}
console.log("voice-worker request builder, ledger and turn plans: all properties hold");
