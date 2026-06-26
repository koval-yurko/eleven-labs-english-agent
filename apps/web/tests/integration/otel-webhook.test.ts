import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryLiveStoryRepository, OtelWebhookService } from "@idiomatic/live-story";
import { counterIdGenerator, fixedClock } from "../helpers";

/**
 * Integration (008-langsmith-tracing, T013): the post-call OTel webhook relay end-to-end over
 * the in-memory live-story repo + a faked fetch (no live keys). Covers: valid signature + known
 * conversation → forwarded; unknown conversation → unmatched; bad signature → 401; no
 * LANGSMITH_API_KEY → no_sink; downstream failure → still best-effort (httpStatus 200).
 */

const SECRET = "whsec_integration";
const PROJECT = "eleven-labs-english-agent";
const KEY_ENV = { LANGSMITH_API_KEY: "ls_key" } as unknown as NodeJS.ProcessEnv;

const otelFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../packages/live-story/tests/fixtures/otel-delivery.json", import.meta.url)), "utf8"),
);
const jsonFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../packages/live-story/tests/fixtures/post-call-transcription.json", import.meta.url)), "utf8"),
);

function sign(body: string, secret = SECRET): string {
  const t = String(Math.floor(Date.now() / 1000));
  return `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

let repo: InMemoryLiveStoryRepository;
beforeEach(() => {
  repo = new InMemoryLiveStoryRepository(counterIdGenerator("sess"), fixedClock());
});

async function seedSessionWithConversation(conversationId: string): Promise<void> {
  const s = await repo.openSession({ lessonId: "lesson-1", ownerId: "auth0|alice", scenario: null });
  await repo.setConversationId("auth0|alice", s.id, conversationId);
}

function makeService(forwardFetch: typeof fetch, env = KEY_ENV) {
  return new OtelWebhookService(repo, {
    webhookSecret: SECRET,
    langsmithProject: PROJECT,
    env,
    fetchImpl: forwardFetch,
  });
}

describe("OtelWebhookService relay", () => {
  it("forwards a correlated delivery and enriches with lesson/owner", async () => {
    await seedSessionWithConversation(otelFixture.data.conversation_id);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const body = JSON.stringify(otelFixture);

    const res = await makeService(fetchImpl as unknown as typeof fetch).handleDelivery({
      rawBody: body,
      signatureHeader: sign(body),
    });

    expect(res).toEqual({ status: "forwarded", httpStatus: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/otel/v1/traces");
    // Enriched with lesson/owner before forwarding.
    const sent = JSON.parse(init.body as string);
    const attrs = sent.resourceSpans[0].resource.attributes as Array<{ key: string }>;
    expect(attrs.some((a) => a.key === "langsmith.metadata.lessonId")).toBe(true);
    expect(attrs.some((a) => a.key === "langsmith.metadata.ownerId")).toBe(true);
  });

  it("forwards uncorrelated + tagged unmatched when the conversation id is unknown", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const body = JSON.stringify(otelFixture); // no seeded session

    const res = await makeService(fetchImpl as unknown as typeof fetch).handleDelivery({
      rawBody: body,
      signatureHeader: sign(body),
    });

    expect(res).toEqual({ status: "unmatched", httpStatus: 200 });
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const attrs = sent.resourceSpans[0].resource.attributes as Array<{ key: string }>;
    expect(attrs.some((a) => a.key === "langsmith.metadata.unmatched")).toBe(true);
    expect(attrs.some((a) => a.key === "langsmith.metadata.lessonId")).toBe(false);
  });

  it("rejects a bad signature with 401 and never forwards", async () => {
    const fetchImpl = vi.fn();
    const body = JSON.stringify(otelFixture);
    const res = await makeService(fetchImpl as unknown as typeof fetch).handleDelivery({
      rawBody: body,
      signatureHeader: sign(body, "wrong-secret"),
    });
    expect(res).toEqual({ status: "rejected", httpStatus: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports no_sink (still 200) when LANGSMITH_API_KEY is unset", async () => {
    await seedSessionWithConversation(otelFixture.data.conversation_id);
    const fetchImpl = vi.fn();
    const body = JSON.stringify(otelFixture);
    const svc = makeService(fetchImpl as unknown as typeof fetch, {} as unknown as NodeJS.ProcessEnv);
    const res = await svc.handleDelivery({ rawBody: body, signatureHeader: sign(body) });
    expect(res).toEqual({ status: "no_sink", httpStatus: 200 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 200 (forward_failed) on a downstream LangSmith error — best-effort (FR-008)", async () => {
    await seedSessionWithConversation(otelFixture.data.conversation_id);
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const body = JSON.stringify(otelFixture);
    const res = await makeService(fetchImpl as unknown as typeof fetch).handleDelivery({
      rawBody: body,
      signatureHeader: sign(body),
    });
    expect(res).toEqual({ status: "forward_failed", httpStatus: 200 });
  });

  it("builds gen_ai LLM spans from a JSON post_call_transcription delivery", async () => {
    await seedSessionWithConversation(jsonFixture.data.conversation_id);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const body = JSON.stringify(jsonFixture);

    const res = await makeService(fetchImpl as unknown as typeof fetch).handleDelivery({
      rawBody: body,
      signatureHeader: sign(body),
    });

    expect(res).toEqual({ status: "forwarded", httpStatus: 200 });
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const spans = sent.resourceSpans[0].scopeSpans.flatMap((s: { spans: unknown[] }) => s.spans) as Array<{
      name: string;
      attributes: Array<{ key: string; value: Record<string, unknown> }>;
    }>;
    const llm = spans.find((s) => /^teacher turn \d+$/.test(s.name))!;
    const keys = llm.attributes.map((a) => a.key);
    // Real telemetry the native OTel skeleton lacked: model + per-turn tokens + content.
    expect(keys).toContain("gen_ai.usage.input_tokens");
    expect(keys).toContain("gen_ai.request.model");
    expect(keys).toContain("gen_ai.completion.0.content");
    // Span-level identity injection so the trace is filterable + threaded.
    expect(keys).toContain("langsmith.metadata.lessonId");
    expect(keys).toContain("langsmith.metadata.thread_id");
    // Authoritative call-level totals land on the root conversation span.
    const rootKeys = spans.find((s) => s.name === "elevenlabs.conversation")!.attributes.map((a) => a.key);
    expect(rootKeys).toContain("gen_ai.usage.input_tokens");
    expect(rootKeys).toContain("langsmith.metadata.llm_cost_usd");
  });

  it("accepts (200, no_spans) a non-traced event type fanned to the same endpoint", async () => {
    // ElevenLabs sends post_call_audio / call_initiation_failure to the same URL; ignore, don't 400.
    const fetchImpl = vi.fn();
    const body = JSON.stringify({
      type: "post_call_audio",
      event_timestamp: 1782993600,
      data: { conversation_id: "conv_audio_1", full_audio: "<base64>" },
    });
    const res = await makeService(fetchImpl as unknown as typeof fetch).handleDelivery({
      rawBody: body,
      signatureHeader: sign(body),
    });
    expect(res).toEqual({ status: "no_spans", httpStatus: 200 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 400 on a verified but unrecognized body", async () => {
    const body = JSON.stringify({ not: "a delivery" });
    const res = await makeService(vi.fn() as unknown as typeof fetch).handleDelivery({
      rawBody: body,
      signatureHeader: sign(body),
    });
    expect(res).toEqual({ status: "invalid", httpStatus: 400 });
  });
});
