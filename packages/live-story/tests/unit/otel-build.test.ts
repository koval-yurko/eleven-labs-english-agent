import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildResourceSpansFromConversation,
  type ConversationPayload,
} from "../../src/services/otel-build";

/**
 * Unit test for the JSON `post_call_transcription` → `gen_ai` OTLP span builder
 * (008-langsmith-tracing, R2 / B1). The fixture mirrors a CAPTURED real conversation: tokens nest
 * as `model_usage.<model>.input.tokens`, authoritative totals live at call level in
 * `metadata.charging.llm_usage`, most agent turns have `message: null`, and TTFB is under
 * `metrics.convai_llm_service_ttfb.elapsed_time`.
 */

type KV = { key: string; value: Record<string, unknown> };
type Span = { name: string; spanId: string; parentSpanId?: string; attributes: KV[] };

function allSpans(resourceSpans: unknown[]): Span[] {
  const group = resourceSpans[0] as { scopeSpans: Array<{ spans: Span[] }> };
  return group.scopeSpans.flatMap((s) => s.spans);
}
function attr(span: Span, key: string): unknown {
  return span.attributes.find((a) => a.key === key)?.value;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/post-call-transcription.json", import.meta.url)), "utf8"),
) as { event_timestamp: number; data: ConversationPayload };

describe("buildResourceSpansFromConversation", () => {
  const out = buildResourceSpansFromConversation({
    data: fixture.data,
    eventTimestampSecs: fixture.event_timestamp,
  });
  const spans = allSpans(out);
  const root = spans.find((s) => s.name === "elevenlabs.conversation")!;

  it("puts authoritative call-level tokens + USD cost + summary on the root", () => {
    expect(attr(root, "langsmith.span.kind")).toEqual({ stringValue: "chain" });
    expect(attr(root, "output.value")).toEqual({
      stringValue: "Learner practiced buying a return train ticket to London.",
    });
    // initiated_generation across both models: input 61382+0+0+2804 = 64186; output 1558+20 = 1578.
    expect(attr(root, "gen_ai.usage.input_tokens")).toEqual({ intValue: 64186 });
    expect(attr(root, "gen_ai.usage.output_tokens")).toEqual({ intValue: 1578 });
    // Real USD LLM cost = charging.llm_price; the credit cost is kept separate (not dollars).
    expect(attr(root, "langsmith.metadata.llm_cost_usd")).toEqual({ doubleValue: 0.0696 });
    expect(attr(root, "langsmith.metadata.cost_credits")).toEqual({ intValue: 700 });
  });

  it("emits one llm span per agent UTTERANCE and skips null-message interim rows", () => {
    const teacher = spans.filter((s) => /^teacher turn \d+$/.test(s.name));
    expect(teacher).toHaveLength(2); // the `message: null` agent row is dropped

    const first = teacher[0];
    expect(attr(first, "langsmith.span.kind")).toEqual({ stringValue: "llm" });
    expect(attr(first, "gen_ai.request.model")).toEqual({ stringValue: "claude-haiku-4-5" });
    // Per-turn nested tokens: input.tokens (850) + input_cache_read.tokens (120) = 970; output 42.
    expect(attr(first, "gen_ai.usage.input_tokens")).toEqual({ intValue: 970 });
    expect(attr(first, "gen_ai.usage.output_tokens")).toEqual({ intValue: 42 });
    expect(attr(first, "gen_ai.completion.0.content")).toEqual({
      stringValue: "Welcome! Let's set the scene at a busy train station.",
    });
    expect(attr(first, "gen_ai.server.time_to_first_token_ms")).toEqual({ intValue: 412 });
  });

  it("folds the preceding learner turn into the next agent utterance's prompt", () => {
    const second = spans.find((s) => s.name === "teacher turn 2")!;
    expect(attr(second, "gen_ai.prompt.0.content")).toEqual({
      stringValue: "I want to ask for a ticket to London.",
    });
  });

  it("emits a tool span as a child of the utterance that called it", () => {
    const second = spans.find((s) => s.name === "teacher turn 2")!;
    const tool = spans.find((s) => s.name === "elevenlabs.tool.markItemTaught")!;
    expect(tool.parentSpanId).toBe(second.spanId);
    expect(attr(tool, "langsmith.span.kind")).toEqual({ stringValue: "tool" });
    expect(attr(tool, "input.value")).toEqual({ stringValue: '{"item":"return ticket"}' });
  });

  it("returns no spans when there is no transcript", () => {
    expect(buildResourceSpansFromConversation({ data: { conversation_id: "x" } })).toEqual([]);
  });
});
