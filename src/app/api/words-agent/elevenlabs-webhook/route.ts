import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

import { elevenLabsConfig } from "../../../../lib/config";
import { json, apiError } from "../../../../lib/http";
import { traceConversation, type PostCallWebhookEvent } from "../../../../lib/langsmith-trace";

// Must run per-request (reads secrets, verifies a signature, calls out to LangSmith).
export const dynamic = "force-dynamic";

/**
 * ElevenLabs post-call webhook → LangSmith. After each tutor lesson, ElevenLabs POSTs the
 * full transcript (User/Teacher turns, any tool calls, token usage) here; we verify its HMAC
 * signature and push it to LangSmith as one trace so the conversation is observable.
 *
 * This endpoint is intentionally PUBLIC (no Auth0) — webhooks are unauthenticated by design;
 * the `ElevenLabs-Signature` HMAC IS the authentication, so we reject anything that fails it.
 * Configure the webhook + shared secret in the ElevenLabs workspace (Workspace → Webhooks) and
 * set ELEVENLABS_WEBHOOK_SECRET. See docs/2026-06-28-langsmith-tracing-observability.md (B1).
 */
export async function POST(req: Request) {
  const { apiKey, webhookSecret } = elevenLabsConfig();
  if (!webhookSecret) return apiError(500, "config", "ELEVENLABS_WEBHOOK_SECRET is not set.");
  if (!process.env.LANGSMITH_API_KEY?.trim()) {
    return apiError(500, "config", "LANGSMITH_API_KEY is not set.");
  }

  const signature = req.headers.get("elevenlabs-signature");
  if (!signature) return apiError(401, "unsigned", "Missing ElevenLabs-Signature header.");

  // Verify against the RAW body — constructEvent checks the HMAC + timestamp and parses JSON.
  const raw = await req.text();
  let event: PostCallWebhookEvent;
  try {
    const client = new ElevenLabsClient({ apiKey });
    event = (await client.webhooks.constructEvent(
      raw,
      signature,
      webhookSecret,
    )) as unknown as PostCallWebhookEvent;
  } catch (e) {
    return apiError(401, "bad_signature", e instanceof Error ? e.message : "Invalid signature.");
  }

  // We only trace completed transcriptions; ack (don't error) on other event types.
  if (event.type !== "post_call_transcription") {
    return json({ ok: true, ignored: event.type });
  }

  try {
    await traceConversation(event.data);
  } catch (e) {
    // A tracing failure is OURS, not ElevenLabs' — ack so they don't retry-storm; we log it.
    console.error(
      `[elevenlabs-webhook] failed to trace conversation ${event.data?.conversation_id}:`,
      e,
    );
    return json({ ok: false, traced: false });
  }

  return json({ ok: true, traced: true, conversationId: event.data.conversation_id });
}
