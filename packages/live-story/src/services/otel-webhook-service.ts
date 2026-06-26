import { TelemetryDelivery } from "@idiomatic/contracts";
import { forwardOtlpToLangSmith, noopLogger, type Logger } from "@idiomatic/generator";
import type { LiveStoryRepository } from "../persistence/repository";
import { verifyElevenLabsSignature } from "./hmac";
import { buildResourceSpansFromConversation } from "./otel-build";
import { enrichResourceSpans } from "./otel-enrich";

/**
 * Orchestrates the ElevenLabs post-call OTel webhook → LangSmith OTLP relay
 * (008-langsmith-tracing, US1). The single responsibility: turn one verified delivery into one
 * forwarded, lesson/owner-correlated trace — best-effort, never throwing into the caller.
 *
 * verify (HMAC over raw body, FR-007) → parse → correlate `conversation_id` → enrich the
 * `resourceSpans` with lesson/owner (or tag `unmatched` when correlation misses, FR-005) →
 * forward to LangSmith OTLP (soft; `no_sink` without a key). The route maps the outcome to an
 * HTTP status; a downstream forward failure still returns 200 so ElevenLabs does not retry a
 * fault on OUR sink (FR-008).
 */

export type WebhookStatus =
  | "rejected" // bad/absent HMAC → 401
  | "invalid" // body is not a recognized envelope → 400
  | "no_spans" // recognized but no OTel resourceSpans (JSON-only variant) → 200
  | "no_sink" // forwarded path but LANGSMITH_API_KEY unset → 200
  | "forwarded" // correlated + forwarded → 200
  | "unmatched" // forwarded uncorrelated (unknown conversation id) → 200
  | "forward_failed" // downstream LangSmith error → 200 (best-effort, FR-008)
  | "error"; // unexpected internal error → 200

export interface WebhookResult {
  status: WebhookStatus;
  httpStatus: 200 | 400 | 401;
}

export interface OtelWebhookServiceOptions {
  webhookSecret: string | undefined;
  langsmithProject: string;
  /** Resolved LangSmith base URL; passed through so the forwarder doesn't re-read env itself. */
  langsmithEndpoint?: string;
  /** Env for the forwarder's key lookup; injected for tests. */
  env?: NodeJS.ProcessEnv;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Injected for tests; defaults to the real OTLP forwarder. */
  forward?: typeof forwardOtlpToLangSmith;
}

export interface HandleDeliveryInput {
  /** The exact raw request body (for HMAC + parse). */
  rawBody: string;
  signatureHeader: string | null | undefined;
  /** Injected clock for HMAC freshness in tests. */
  nowMs?: number;
}

export class OtelWebhookService {
  private readonly forward: typeof forwardOtlpToLangSmith;
  private readonly log: Logger;

  constructor(
    private readonly repo: LiveStoryRepository,
    private readonly opts: OtelWebhookServiceOptions,
  ) {
    this.forward = opts.forward ?? forwardOtlpToLangSmith;
    this.log = opts.logger ?? noopLogger;
  }

  async handleDelivery(input: HandleDeliveryInput): Promise<WebhookResult> {
    // 1. Authenticity FIRST, over the RAW body — the only guard on a public ingress (FR-007).
    const verified = verifyElevenLabsSignature({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader,
      secret: this.opts.webhookSecret,
      nowMs: input.nowMs,
    });
    if (!verified) {
      this.log.warn("story.error", "otel webhook: signature rejected", {});
      return { status: "rejected", httpStatus: 401 };
    }

    // 2. Parse + structural validation. A malformed body — whether it fails JSON.parse or the
    //    envelope schema — is an unrecognized payload a redelivery won't fix: both map to 400
    //    `invalid` (kept OUT of the best-effort try below so they aren't swallowed into a 200).
    let json: unknown;
    try {
      json = JSON.parse(input.rawBody);
    } catch {
      // Not JSON at all — log a short preview so a foreign body is diagnosable, not a silent 400.
      this.log.warn("story.error", "otel webhook: body is not JSON", {
        preview: input.rawBody.slice(0, 200),
      });
      return { status: "invalid", httpStatus: 400 };
    }
    const parsed = TelemetryDelivery.safeParse(json);
    if (!parsed.success) {
      // The signature already verified, so this IS from ElevenLabs — the envelope just doesn't
      // match what we expect. Log the structural shape (top-level keys, `type`, and the failing
      // Zod paths — field NAMES, not values) so the real payload can correct the schema. The full
      // raw body (may carry transcript text) is debug-gated per Constitution V.
      const obj = (typeof json === "object" && json) as Record<string, unknown> | null;
      this.log.warn("story.error", "otel webhook: unrecognized envelope", {
        topLevelKeys: obj ? Object.keys(obj) : [],
        type: obj?.type,
        dataKeys:
          obj && typeof obj.data === "object" && obj.data
            ? Object.keys(obj.data as Record<string, unknown>)
            : [],
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`),
      });
      this.log.debug("story.trace", "otel webhook: rejected raw body", { rawBody: input.rawBody });
      return { status: "invalid", httpStatus: 400 };
    }
    const { type, event_timestamp } = parsed.data;
    const { data } = parsed.data;

    try {
      // Source the spans. The native OTel export (`post_call_transcription_otel`) is an event
      // skeleton with no content/tokens/cost — we forward it only when the richer JSON variant
      // isn't configured. The JSON `post_call_transcription` carries the real telemetry, so we
      // BUILD `gen_ai` spans from it (per-turn LLM runs · tokens · cost · TTFB · tool spans).
      let resourceSpans: unknown[] | undefined;
      if (type === "post_call_transcription") {
        // Raw payload at debug only (carries transcript text — Constitution V gating).
        this.log.debug("story.trace", "otel webhook: json delivery", { rawBody: input.rawBody });
        resourceSpans = buildResourceSpansFromConversation({
          data,
          eventTimestampSecs: event_timestamp,
        });
      } else if (type === "post_call_transcription_otel") {
        resourceSpans = data.otlp_traces?.resourceSpans ?? undefined;
      } else {
        // Another event fanned to the same endpoint (`post_call_audio`,
        // `call_initiation_failure`, …). Not something we trace — accept so ElevenLabs doesn't
        // retry, and leave `resourceSpans` undefined to fall through to the no_spans 200 below.
        this.log.info("story.trace", "otel webhook: ignored event type", {
          conversationId: data.conversation_id,
          eventType: type,
        });
      }

      if (!resourceSpans || resourceSpans.length === 0) {
        // Recognized envelope with nothing traceable (empty OTel, or a JSON call with no turns).
        // Accept — a redelivery won't add spans. Log it so a 200 isn't a silent drop.
        this.log.info("story.trace", "otel webhook: no spans to forward", {
          conversationId: data.conversation_id,
        });
        return { status: "no_spans", httpStatus: 200 };
      }

      // 3. Correlate conversation_id → lesson/owner (service-role lookup, R3).
      const correlation = await this.repo.findSessionByConversationId(data.conversation_id);

      // 4. Enrich the spans with identity + thread + filterable session summary (US3, FR-006/012),
      //    or tag `unmatched` when correlation misses (FR-005). The session read is best-effort —
      //    if it fails, lesson/owner/thread still go on.
      let enriched: unknown[];
      if (correlation) {
        const session = await this.repo
          .getSession(correlation.ownerId, correlation.sessionId)
          .catch(() => null);
        enriched = enrichResourceSpans(resourceSpans, {
          lessonId: correlation.lessonId,
          ownerId: correlation.ownerId,
          scenario: session?.scenario ?? undefined,
          status: session?.status,
          turnCount: session?.turns.length,
        });
      } else {
        enriched = enrichResourceSpans(resourceSpans, { unmatched: true });
      }

      // 5. Forward to LangSmith OTLP (soft).
      const forwarded = await this.forward(enriched, {
        project: this.opts.langsmithProject,
        endpoint: this.opts.langsmithEndpoint,
        env: this.opts.env,
        fetchImpl: this.opts.fetchImpl,
      });

      if (forwarded.reason === "no_sink") return { status: "no_sink", httpStatus: 200 };
      if (!forwarded.ok) {
        this.log.warn("story.error", "otel webhook: forward failed", {
          conversationId: data.conversation_id,
        });
        return { status: "forward_failed", httpStatus: 200 };
      }

      this.log.info("story.trace", "otel trace forwarded", {
        conversationId: data.conversation_id,
        matched: Boolean(correlation),
      });
      return {
        status: correlation ? "forwarded" : "unmatched",
        httpStatus: 200,
      };
    } catch {
      // Best-effort: a verified, well-formed delivery must never 5xx (FR-008).
      return { status: "error", httpStatus: 200 };
    }
  }
}
