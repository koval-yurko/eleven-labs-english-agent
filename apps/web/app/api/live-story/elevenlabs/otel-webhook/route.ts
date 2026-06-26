import { getOtelWebhookService } from "../../../../../lib/container";
import { apiError, json } from "../../../../../lib/http";

/**
 * POST /api/live-story/elevenlabs/otel-webhook — ElevenLabs post-call telemetry ingress
 * (008-langsmith-tracing, US1). NOT Auth0-authenticated: the caller is ElevenLabs, not a
 * learner. Authenticity is the HMAC signature over the RAW body, verified inside the service
 * (FR-007). The service unwraps the OTel `resourceSpans`, correlates `conversation_id` →
 * lesson/owner, enriches, and forwards to LangSmith OTLP — all best-effort.
 *
 * Mapping: a verified, well-formed delivery always yields 200 (even when the downstream
 * LangSmith forward fails — a redelivery would not fix OUR sink, FR-008). A bad/absent
 * signature is 401; an unrecognized body is 400.
 */
export async function POST(request: Request) {
  // Read the RAW body — HMAC must be computed over exactly what ElevenLabs signed.
  const rawBody = await request.text();
  const signatureHeader =
    request.headers.get("ElevenLabs-Signature") ?? request.headers.get("elevenlabs-signature");

  const outcome = await getOtelWebhookService().handleDelivery({ rawBody, signatureHeader });

  if (outcome.httpStatus === 401) {
    return apiError(401, "invalid_signature", "Webhook signature verification failed.");
  }
  if (outcome.httpStatus === 400) {
    return apiError(400, "invalid_body", "Unrecognized telemetry payload.");
  }
  return json({ status: outcome.status }, 200);
}
