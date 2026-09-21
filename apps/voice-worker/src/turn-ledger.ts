/**
 * Builds one `TurnRecord` per completed tutor turn (research doc §5.2) from what an `AgentSession`
 * reports while it runs: LLM metrics, the Claude adapter's completion text, and the chat items the
 * session commits.
 *
 * Pure on purpose. `agent.ts` maps the framework's events onto the plain inputs below, which keeps
 * the bookkeeping checkable in `src/check.ts` without a room, a mic or a network call.
 *
 * Where records go: in Phase 2, a JSONL file under `.local/ledger/` plus one line on stdout. Phase 3
 * posts the same records in batches to `/api/v2/livekit/session-end`.
 *
 * A turn closes when the session commits the tutor's message. Everything seen since the previous
 * close belongs to it: the learner's message(s), every LLM request (including preemptive ones
 * that were thrown away, which are billed too), tool calls and errors. Metrics that arrive after
 * the tutor's message is committed roll into the next turn. That is rare, since the LLM finishes
 * before playout does, and it only moves tokens between adjacent turns, never loses them.
 */
import type { TurnRecord } from "@tutor/shared/tutor/livekit-wire";

/** One LLM request, from the framework's `llm_metrics`. */
export interface LedgerLlmCall {
  requestId: string;
  /** Aborted before it finished, which is what a discarded preemptive generation looks like. */
  cancelled: boolean;
  ttftMs: number;
  /** Everything sent, cached or not (the adapter reports it that way). */
  promptTokens: number;
  promptCachedTokens: number;
  cacheCreationTokens?: number;
  completionTokens: number;
  model?: string;
}

/** A chat message the session committed. Latencies are in SECONDS, as `ChatMessage.metrics` has them. */
export interface LedgerMessage {
  role: "user" | "assistant";
  text: string;
  interrupted: boolean;
  createdAtMs: number;
  metrics: {
    transcriptionDelay?: number;
    endOfTurnDelay?: number;
    llmNodeTtft?: number;
    ttsNodeTtfb?: number;
    e2eLatency?: number;
  };
}

export class TurnLedger {
  readonly #model: string;
  readonly #startedAtMs: number;
  readonly #onRecord: (record: TurnRecord) => void;

  #seq = 0;
  #userMessages: LedgerMessage[] = [];
  #calls: LedgerLlmCall[] = [];
  #completions = new Map<string, string>();
  #toolCalls: string[] = [];
  #errors: string[] = [];
  #falseInterruptionResumed = false;

  constructor(opts: { model: string; startedAtMs: number; onRecord: (record: TurnRecord) => void }) {
    this.#model = opts.model;
    this.#startedAtMs = opts.startedAtMs;
    this.#onRecord = opts.onRecord;
  }

  llmCall(call: LedgerLlmCall): void {
    this.#calls.push(call);
  }

  /** The full text Claude generated for one request. It can differ from what was heard, since a
   *  barge-in cuts the spoken text short. */
  completion(requestId: string, text: string): void {
    this.#completions.set(requestId, text);
  }

  toolsExecuted(names: string[]): void {
    this.#toolCalls.push(...names);
  }

  falseInterruption(resumed: boolean): void {
    if (resumed) this.#falseInterruptionResumed = true;
  }

  /** e.g. "llm:APIStatusError", "stt:reconnect", "tts:timeout". */
  error(label: string): void {
    this.#errors.push(label);
  }

  message(msg: LedgerMessage): void {
    if (msg.role === "user") {
      this.#userMessages.push(msg);
      return;
    }
    this.#close(msg);
  }

  #close(agent: LedgerMessage): void {
    const users = this.#userMessages;
    const lastUser = users[users.length - 1];
    const kept = this.#calls.filter((c) => !c.cancelled);
    const sum = (pick: (c: LedgerLlmCall) => number) => this.#calls.reduce((n, c) => n + pick(c), 0);
    const cacheReadTokens = sum((c) => c.promptCachedTokens);
    const cacheWriteTokens = sum((c) => c.cacheCreationTokens ?? 0);
    const generated = kept
      .map((c) => this.#completions.get(c.requestId))
      .filter((t): t is string => !!t)
      .join(" ");
    const ms = (secs: number | undefined) => (secs === undefined ? -1 : Math.round(secs * 1000));
    // The tutor's own message first, then the learner's messages newest-first: when a learner turn
    // arrives as two messages, only one of them may carry the delay.
    const firstOf = (key: keyof LedgerMessage["metrics"]) =>
      agent.metrics[key] ?? users.findLast((u) => u.metrics[key] !== undefined)?.metrics[key];

    this.#onRecord({
      seq: this.#seq++,
      atSecs: ((lastUser ?? agent).createdAtMs - this.#startedAtMs) / 1000,
      userText: users.map((u) => u.text).join(" "),
      agentText: generated || agent.text,
      agentHeardText: agent.text,
      interrupted: agent.interrupted,
      falseInterruptionResumed: this.#falseInterruptionResumed,
      endOfTurnDelayMs: ms(firstOf("endOfTurnDelay")),
      transcriptionDelayMs: ms(firstOf("transcriptionDelay")),
      llmTtftMs: agent.metrics.llmNodeTtft !== undefined ? ms(agent.metrics.llmNodeTtft) : (kept.at(-1)?.ttftMs ?? -1),
      ttsTtfbMs: ms(agent.metrics.ttsNodeTtfb),
      e2eLatencyMs: ms(agent.metrics.e2eLatency),
      model: kept.at(-1)?.model ?? this.#model,
      preemptiveAttempts: this.#calls.length - kept.length,
      // The adapter's promptTokens already includes both cache buckets; this field is the UNcached part.
      inputTokens: sum((c) => c.promptTokens) - cacheReadTokens - cacheWriteTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens: sum((c) => c.completionTokens),
      toolCalls: this.#toolCalls,
      errors: this.#errors,
    });

    this.#userMessages = [];
    this.#calls = [];
    this.#completions = new Map();
    this.#toolCalls = [];
    this.#errors = [];
    this.#falseInterruptionResumed = false;
  }
}
