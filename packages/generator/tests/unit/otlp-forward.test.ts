import { describe, expect, it, vi } from "vitest";
import { forwardOtlpToLangSmith } from "../../src/observability/otlp-forward";

/**
 * Contract test for the LangSmith OTLP forwarder (008-langsmith-tracing, T011). Soft dependency:
 * no key ⇒ no network call; with a key ⇒ a POST to /otel/v1/traces with the right headers; a
 * non-2xx downstream ⇒ forward_failed (and the caller still treats the webhook as best-effort).
 */

const spans = [{ resource: { attributes: [] }, scopeSpans: [] }];

describe("forwardOtlpToLangSmith", () => {
  it("no-ops (no_sink) and never calls fetch when no LANGSMITH_API_KEY is set", async () => {
    const fetchImpl = vi.fn();
    const res = await forwardOtlpToLangSmith(spans, {
      project: "p",
      env: {} as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: false, reason: "no_sink" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs to /otel/v1/traces with x-api-key + Langsmith-Project when keyed", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const res = await forwardOtlpToLangSmith(spans, {
      project: "eleven-labs-english-agent",
      env: {
        LANGSMITH_API_KEY: "ls_key",
        LANGSMITH_ENDPOINT: "https://api.smith.langchain.com",
      } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.smith.langchain.com/otel/v1/traces");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ls_key");
    expect(headers["Langsmith-Project"]).toBe("eleven-labs-english-agent");
    expect(JSON.parse(init.body as string)).toEqual({ resourceSpans: spans });
  });

  it("reports forward_failed on a non-2xx downstream", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const res = await forwardOtlpToLangSmith(spans, {
      project: "p",
      env: { LANGSMITH_API_KEY: "ls_key" } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, reason: "forward_failed", status: 500 });
  });

  it("reports forward_failed (never throws) on a transport error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const res = await forwardOtlpToLangSmith(spans, {
      project: "p",
      env: { LANGSMITH_API_KEY: "ls_key" } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: false, reason: "forward_failed" });
  });
});
