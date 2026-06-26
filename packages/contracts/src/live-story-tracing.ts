import { z } from "zod";

/**
 * Inbound ElevenLabs post-call webhook envelope (008-langsmith-tracing, data-model.md).
 *
 * ElevenLabs POSTs this when a story call ends. Two variants, discriminated by `type`:
 *   - `post_call_transcription_otel` — carries `data.otlp_traces.resourceSpans`, forwarded to
 *     LangSmith's OTLP ingest (the primary path, R1).
 *   - `post_call_transcription` — the JSON fallback (B1, R2): `metadata`/`conversation_turn_metrics`
 *     used to hand-build a trace if the OTel spans prove too thin.
 *
 * `.passthrough()` keeps unknown fields (the payload is large and provider-owned); we validate
 * only what we depend on. Authenticity is established by HMAC over the RAW body BEFORE parsing —
 * this schema is structural validation, not a trust boundary.
 */
export const TelemetryDeliveryData = z
  .object({
    conversation_id: z.string().min(1),
    // Optional: we never read it, and requiring it would 400 a delivery that merely omits it.
    agent_id: z.string().min(1).optional(),
    // `.nullish()`, NOT `.optional()`: the JSON `post_call_transcription` body carries
    // `otlp_traces: null` (the field is present but null when the OTel format is off). `.optional()`
    // accepts undefined but rejects null — which 400'd every JSON delivery.
    otlp_traces: z
      .object({ resourceSpans: z.array(z.unknown()) })
      .passthrough()
      .nullish(),
    metadata: z.record(z.unknown()).optional(),
    conversation_turn_metrics: z.record(z.unknown()).optional(),
    // JSON `post_call_transcription` body (B1, R2): the per-turn transcript + analysis the trace
    // is hand-built from. Loosely typed (provider-owned, large) — only the shape we read is named;
    // the builder accesses fields tolerantly. `.passthrough()` keeps everything else.
    transcript: z.array(z.record(z.unknown())).optional(),
    analysis: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const TelemetryDelivery = z
  .object({
    // Any string: ElevenLabs fans MULTIPLE event types to the one endpoint —
    // `post_call_transcription[_otel]` (handled), plus `post_call_audio` /
    // `call_initiation_failure` (ignored with a 200). A strict enum would 400 the latter and
    // make ElevenLabs retry an event we simply don't trace. The service switches on `type`.
    type: z.string().min(1),
    event_timestamp: z.number().optional(),
    data: TelemetryDeliveryData,
  })
  .passthrough();

export type TelemetryDelivery = z.infer<typeof TelemetryDelivery>;
export type TelemetryDeliveryData = z.infer<typeof TelemetryDeliveryData>;
