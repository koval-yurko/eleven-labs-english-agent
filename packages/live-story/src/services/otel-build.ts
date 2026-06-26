/**
 * Build rich `gen_ai` OTLP spans from ElevenLabs' JSON `post_call_transcription` payload
 * (008-langsmith-tracing, R2 / B1). The native OTel export (`post_call_transcription_otel`)
 * emits an *event* skeleton — `recv.*` / `tool.*` spans with no content, tokens, cost, or model —
 * so forwarding it verbatim yields a hollow trace. The telemetry lives in the JSON conversation
 * object; this translates it into spans carrying the attributes LangSmith maps to LLM runs
 * (`langsmith.span.kind=llm`, `gen_ai.usage.*`, `gen_ai.request.model`, `gen_ai.prompt/completion.*`).
 *
 * Shapes below are CAPTURED from a real `GET /v1/convai/conversations/{id}` (not guessed):
 *   - tokens nest as `llm_usage.model_usage.<model>.{input|input_cache_read|output_total}.tokens`
 *     — an object with `.tokens` + `.price`, NOT a bare number;
 *   - most agent turns carry `message: null` (interim/tool rows) — only a few are real utterances;
 *   - per-turn `llm_usage` is sparse, so the authoritative totals come from the CALL level:
 *     `metadata.charging.llm_usage.initiated_generation.model_usage.<model>.…` (its summed `.price`
 *     equals `metadata.charging.llm_price`, the real USD LLM cost), put on the root span;
 *   - TTFB is `conversation_turn_metrics.metrics.convai_llm_service_ttfb.elapsed_time` (seconds);
 *   - `metadata.cost` is ElevenLabs *credits*, not USD — surfaced separately from `llm_cost_usd`.
 *
 * Pure + tolerant: every field is optional and read through accessors, so shape drift degrades to
 * a thinner-but-valid span rather than throwing — the webhook stays best-effort (FR-008).
 */

import { createHash } from "node:crypto";

/** Loosely-typed view of the JSON conversation `data` we read. Everything optional. */
export interface ConversationPayload {
  conversation_id?: string;
  transcript?: TranscriptTurn[];
  metadata?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
}

interface TranscriptTurn {
  role?: string; // "user" | "agent"
  message?: string | null;
  time_in_call_secs?: number;
  conversation_turn_metrics?: Record<string, unknown>;
  tool_calls?: Array<Record<string, unknown>>;
  tool_results?: Array<Record<string, unknown>>;
  llm_usage?: Record<string, unknown>;
}

type AnyValue = Record<string, unknown>;
type KeyValue = { key: string; value: AnyValue };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
};

const SECOND_NS = 1_000_000_000;

const str = (key: string, value: string): KeyValue => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): KeyValue => ({ key, value: { intValue: value } });
const dbl = (key: string, value: number): KeyValue => ({ key, value: { doubleValue: value } });

/** Deterministic hex id of `n` bytes (2n chars) from a seed, so re-deliveries don't duplicate. */
function hexId(seed: string, bytes: number): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, bytes * 2);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}
/** First finite number among the given keys of an object (tolerant of key drift). */
function pickNum(o: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  if (!o) return undefined;
  for (const k of keys) {
    const n = num(o[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** `.tokens` out of a `{ tokens, price }` leaf (the real per-category shape), tolerant of a bare number. */
function tokensOf(leaf: unknown): number {
  if (typeof leaf === "number") return Number.isFinite(leaf) ? leaf : 0;
  return pickNum(obj(leaf), "tokens") ?? 0;
}
function priceOf(leaf: unknown): number {
  return pickNum(obj(leaf), "price") ?? 0;
}

interface Usage {
  /** Dominant model (most input tokens) — so LangSmith can price the run from its table. */
  model?: string;
  /** All models that contributed, comma-joined (kept as metadata when several were used). */
  models?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Sum a `model_usage` map (`{ "<model>": { input{tokens,price}, output_total{…}, … } }`). */
function sumModelUsage(modelUsage: Record<string, unknown> | undefined): Usage {
  const out: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  if (!modelUsage) return out;
  const models = Object.keys(modelUsage);
  out.models = models.join(", ");
  let dominantInput = -1;
  for (const m of models) {
    const u = obj(modelUsage[m]);
    if (!u) continue;
    const mInput = tokensOf(u.input) + tokensOf(u.input_cache_read) + tokensOf(u.input_cache_write);
    out.inputTokens += mInput;
    out.outputTokens += tokensOf(u.output_total) + tokensOf(u.output);
    out.costUsd += priceOf(u.input) + priceOf(u.input_cache_read) + priceOf(u.output_total);
    if (mInput > dominantInput) {
      dominantInput = mInput;
      out.model = m;
    }
  }
  return out;
}

/** Per-turn usage from a turn's `llm_usage.model_usage` (sparse — present on only some turns). */
function turnUsage(llm: Record<string, unknown> | undefined): Usage | undefined {
  const mu = obj(llm?.model_usage);
  if (!mu || Object.keys(mu).length === 0) return undefined;
  return sumModelUsage(mu);
}

/**
 * Authoritative CALL-level usage from `metadata.charging.llm_usage`. Prefers `initiated_generation`
 * (its summed prices equal `charging.llm_price`); falls back to `irreversible_generation`. Returns
 * undefined when charging data is absent. Cost prefers the explicit `charging.llm_price`.
 */
function callUsage(metadata: Record<string, unknown> | undefined): Usage | undefined {
  const charging = obj(metadata?.charging);
  const llm = obj(charging?.llm_usage);
  const bucket = obj(llm?.initiated_generation) ?? obj(llm?.irreversible_generation);
  const mu = obj(bucket?.model_usage);
  if (!mu) return undefined;
  const summed = sumModelUsage(mu);
  const explicitCost = pickNum(charging, "llm_price");
  return { ...summed, costUsd: explicitCost ?? summed.costUsd };
}

/** Time-to-first-byte (ms) for a turn: `…metrics.convai_llm_service_ttfb.elapsed_time` (secs). */
function ttfbMs(metrics: Record<string, unknown> | undefined): number | undefined {
  const m = obj(metrics?.metrics) ?? metrics;
  const ttfb = obj(m?.convai_llm_service_ttfb) ?? obj(m?.llm_service_ttfb);
  const elapsed = pickNum(ttfb, "elapsed_time", "value");
  return elapsed !== undefined ? Math.round(elapsed * 1000) : undefined;
}

function toolName(call: Record<string, unknown>): string {
  return (
    (typeof call.tool_name === "string" && call.tool_name) ||
    (typeof call.name === "string" && call.name) ||
    "tool"
  );
}

export interface BuildSpansInput {
  data: ConversationPayload;
  /** Call-end epoch (secs) from the delivery envelope, used to anchor timing if metadata lacks it. */
  eventTimestampSecs?: number;
}

/**
 * Translate one JSON conversation into OTLP `resourceSpans`: a root `chain` span carrying the
 * conversation summary + authoritative call-level tokens/cost, one `llm` span per agent *utterance*
 * (turns with real `message` text — the null interim rows are skipped), and a `tool` span per tool
 * call. Returns `[]` when there is nothing traceable.
 */
export function buildResourceSpansFromConversation(input: BuildSpansInput): unknown[] {
  const { data } = input;
  const turns = Array.isArray(data.transcript) ? data.transcript : [];
  const meta = data.metadata ?? {};
  const analysis = data.analysis ?? {};
  const convId = data.conversation_id ?? "unknown";

  const traceId = hexId(`trace:${convId}`, 16);
  const rootSpanId = hexId(`root:${convId}`, 8);

  const durationSecs = pickNum(meta, "call_duration_secs", "duration_secs") ?? 0;
  const startSecs =
    pickNum(meta, "start_time_unix_secs", "start_time") ??
    (input.eventTimestampSecs ? input.eventTimestampSecs - durationSecs : undefined) ??
    input.eventTimestampSecs ??
    0;
  const baseNs = startSecs * SECOND_NS;
  const endNs = baseNs + Math.max(durationSecs, 0) * SECOND_NS;

  const spans: OtlpSpan[] = [];

  // ── Root conversation span ───────────────────────────────────────────────────────────────
  const summary = typeof analysis.transcript_summary === "string" ? analysis.transcript_summary : undefined;
  const rootAttrs: KeyValue[] = [str("langsmith.span.kind", "chain")];
  if (summary) rootAttrs.push(str("output.value", summary));

  // Authoritative call-level tokens + USD cost (the per-turn data is too sparse to total). Put the
  // usage on the root so LangSmith's Tokens/Cost surface the whole conversation, not one stray turn.
  const call = callUsage(meta);
  if (call) {
    if (call.model) rootAttrs.push(str("gen_ai.request.model", call.model));
    if (call.models && call.models !== call.model) {
      rootAttrs.push(str("langsmith.metadata.models", call.models));
    }
    rootAttrs.push(
      int("gen_ai.usage.input_tokens", call.inputTokens),
      int("gen_ai.usage.output_tokens", call.outputTokens),
      int("gen_ai.usage.total_tokens", call.inputTokens + call.outputTokens),
    );
    if (call.costUsd > 0) rootAttrs.push(dbl("langsmith.metadata.llm_cost_usd", call.costUsd));
  }
  const creditCost = pickNum(meta, "cost"); // ElevenLabs credits, NOT dollars.
  if (creditCost !== undefined) rootAttrs.push(int("langsmith.metadata.cost_credits", creditCost));
  if (typeof analysis.call_successful === "string") {
    rootAttrs.push(str("langsmith.metadata.call_successful", analysis.call_successful));
  }
  if (typeof meta.termination_reason === "string" && meta.termination_reason) {
    rootAttrs.push(str("langsmith.metadata.termination_reason", meta.termination_reason));
  }
  spans.push({
    traceId,
    spanId: rootSpanId,
    name: "elevenlabs.conversation",
    kind: 1,
    startTimeUnixNano: String(baseNs),
    endTimeUnixNano: String(endNs || baseNs + 1),
    attributes: rootAttrs,
  });

  // ── Per-turn spans ───────────────────────────────────────────────────────────────────────
  let pendingUserMessage: string | undefined;
  let uttered = 0; // sequential index over real agent utterances (stable, gap-free names)
  turns.forEach((turn, idx) => {
    const role = (turn.role ?? "").toLowerCase();
    const turnStartNs = baseNs + (num(turn.time_in_call_secs) ?? 0) * SECOND_NS;
    const nextTime = num(turns[idx + 1]?.time_in_call_secs);
    const turnEndNs = nextTime !== undefined ? baseNs + nextTime * SECOND_NS : turnStartNs + SECOND_NS;

    if (role === "user") {
      if (typeof turn.message === "string" && turn.message) pendingUserMessage = turn.message;
      return; // folded into the next agent utterance's prompt
    }
    if (role !== "agent") return;

    const hasMessage = typeof turn.message === "string" && turn.message.length > 0;
    const calls = Array.isArray(turn.tool_calls) ? turn.tool_calls : [];
    // Skip the noise: agent rows with no utterance AND no tool call (interim/contextual frames).
    if (!hasMessage && calls.length === 0) return;

    const spanId = hexId(`turn:${convId}:${idx}`, 8);
    const attrs: KeyValue[] = [
      str("langsmith.span.kind", hasMessage ? "llm" : "chain"),
      str("gen_ai.system", "elevenlabs"),
    ];
    const usage = turnUsage(turn.llm_usage);
    if (usage?.model) {
      attrs.push(str("gen_ai.request.model", usage.model), str("gen_ai.response.model", usage.model));
    }
    if (usage) {
      attrs.push(
        int("gen_ai.usage.input_tokens", usage.inputTokens),
        int("gen_ai.usage.output_tokens", usage.outputTokens),
        int("gen_ai.usage.total_tokens", usage.inputTokens + usage.outputTokens),
      );
    }
    if (pendingUserMessage !== undefined) {
      attrs.push(str("gen_ai.prompt.0.role", "user"), str("gen_ai.prompt.0.content", pendingUserMessage));
    }
    if (hasMessage) {
      attrs.push(
        str("gen_ai.completion.0.role", "assistant"),
        str("gen_ai.completion.0.content", turn.message as string),
      );
    }
    const ttfb = ttfbMs(turn.conversation_turn_metrics);
    if (ttfb !== undefined) attrs.push(int("gen_ai.server.time_to_first_token_ms", ttfb));

    uttered += 1;
    spans.push({
      traceId,
      spanId,
      parentSpanId: rootSpanId,
      name: hasMessage ? `teacher turn ${uttered}` : `agent tools ${uttered}`,
      kind: 1,
      startTimeUnixNano: String(turnStartNs),
      endTimeUnixNano: String(Math.max(turnEndNs, turnStartNs + 1)),
      attributes: attrs,
    });
    pendingUserMessage = undefined;

    // Tool spans: children of the agent turn that issued them.
    const results = Array.isArray(turn.tool_results) ? turn.tool_results : [];
    calls.forEach((call, ci) => {
      const result = results[ci] ?? {};
      const latencySecs = pickNum(result, "tool_latency_secs", "latency_secs") ?? 0;
      const toolAttrs: KeyValue[] = [
        str("langsmith.span.kind", "tool"),
        str("gen_ai.tool.name", toolName(call)),
      ];
      if (typeof call.params_as_json === "string") toolAttrs.push(str("input.value", call.params_as_json));
      if (result.result_value !== undefined) toolAttrs.push(str("output.value", String(result.result_value)));
      if (result.is_error === true) toolAttrs.push(str("langsmith.metadata.is_error", "true"));
      spans.push({
        traceId,
        spanId: hexId(`tool:${convId}:${idx}:${ci}`, 8),
        parentSpanId: spanId,
        name: `elevenlabs.tool.${toolName(call)}`,
        kind: 1,
        startTimeUnixNano: String(turnStartNs),
        endTimeUnixNano: String(turnStartNs + Math.max(latencySecs, 0) * SECOND_NS + 1),
        attributes: toolAttrs,
      });
    });
  });

  if (spans.length <= 1 && turns.length === 0) return []; // nothing traceable

  return [
    {
      resource: { attributes: [str("service.name", "elevenlabs-convai")] },
      scopeSpans: [{ scope: { name: "elevenlabs.convai" }, spans }],
    },
  ];
}
