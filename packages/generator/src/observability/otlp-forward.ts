/**
 * Forward OTLP `resourceSpans` to LangSmith's OTLP ingest (008-langsmith-tracing, R7).
 *
 * This is deliberately SEPARATE from {@link ./tracing-runtime}'s shared client: that client
 * wraps LangSmith's run create/update REST API (used by the self-reported session tracer and
 * generation `traceable`), whereas OTLP ingest is a different endpoint with a different body.
 * The body we receive from ElevenLabs is already in LangSmith's expected shape, so this is a
 * thin `fetch` POST — no OTel SDK exporter, no new runtime dependency (Constitution II).
 *
 * Soft, like all our tracing: with no `LANGSMITH_API_KEY` it never calls out and reports
 * `no_sink`; a non-2xx downstream reports `forward_failed`. It never throws — callers stay
 * best-effort (FR-008) and map every outcome to a 2xx for the webhook caller.
 */

export interface ForwardOtlpOptions {
  /** LangSmith project the spans land in (sent as the `Langsmith-Project` header). */
  project: string;
  /**
   * Base LangSmith URL (OTLP ingest is `${endpoint}/otel/v1/traces`). When provided, this wins
   * over the env-derived value — the single source of truth becomes the caller's resolved config
   * (`liveStoryTracingConfig().langsmithEndpoint`) rather than a second independent env read.
   * Omitted ⇒ fall back to `LANGSMITH_ENDPOINT`/`LANGCHAIN_ENDPOINT`/default.
   */
  endpoint?: string;
  /** Env source for the key + base endpoint; injected for tests. */
  env?: NodeJS.ProcessEnv;
  /** Injected fetch for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ForwardOtlpResult {
  ok: boolean;
  reason?: "no_sink" | "forward_failed";
  status?: number;
}

const DEFAULT_ENDPOINT = "https://api.smith.langchain.com";

function apiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.LANGSMITH_API_KEY ?? env.LANGCHAIN_API_KEY;
}

function baseEndpoint(opts: ForwardOtlpOptions, env: NodeJS.ProcessEnv): string {
  const raw = opts.endpoint ?? env.LANGSMITH_ENDPOINT ?? env.LANGCHAIN_ENDPOINT ?? DEFAULT_ENDPOINT;
  return raw.replace(/\/+$/, "");
}

export async function forwardOtlpToLangSmith(
  resourceSpans: unknown[],
  opts: ForwardOtlpOptions,
): Promise<ForwardOtlpResult> {
  const env = opts.env ?? process.env;
  const key = apiKey(env);
  // Soft dependency: no key configured ⇒ no-op, never reaches the network.
  if (!key) return { ok: false, reason: "no_sink" };

  const url = `${baseEndpoint(opts, env)}/otel/v1/traces`;
  const doFetch = opts.fetchImpl ?? fetch;

  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "Langsmith-Project": opts.project,
      },
      body: JSON.stringify({ resourceSpans }),
    });
    if (!res.ok) return { ok: false, reason: "forward_failed", status: res.status };
    return { ok: true, status: res.status };
  } catch {
    // Network/transport failure — best-effort; never throw into the caller.
    return { ok: false, reason: "forward_failed" };
  }
}
