import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { after } from "next/server";

import { elevenLabsConfig } from "../../../../lib/config";
import { json, apiError } from "../../../../lib/http";
import { traceConversation, type PostCallWebhookEvent } from "../../../../lib/langsmith-trace";

// Must run per-request (reads secrets, verifies a signature, calls out to LangSmith).
export const dynamic = "force-dynamic";

// Header marking the relayed copy so the receiving (Dev) instance never forwards it onward.
const RELAYED_HEADER = "x-eleven-relayed";

/**
 * ElevenLabs post-call webhook → LangSmith. After each tutor lesson, ElevenLabs POSTs the
 * full transcript (User/Teacher turns, any tool calls, token usage) here; we verify its HMAC
 * signature and push it to LangSmith as one trace so the conversation is observable.
 *
 * ONE webhook serves BOTH environments. It's configured on Prod, so Prod relays every verified
 * event to the Dev tunnel (ELEVENLABS_WEBHOOK_FORWARD_URL). Each instance then handles only the
 * calls its own UI started — identified by the `app_env` dynamic variable stamped at session
 * start — and acks-and-skips the other env's, so Dev traces stay free of Prod calls.
 *
 * This endpoint is intentionally PUBLIC (no Auth0) — webhooks are unauthenticated by design;
 * the `ElevenLabs-Signature` HMAC IS the authentication, so we reject anything that fails it.
 * Configure the webhook + shared secret in the ElevenLabs workspace (Workspace → Webhooks) and
 * set ELEVENLABS_WEBHOOK_SECRET. See docs/2026-06-28-langsmith-tracing-observability.md (B1).
 */
export async function POST(req: Request) {
  const { apiKey, webhookSecret, appEnv, webhookForwardUrl } = elevenLabsConfig();
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

  // Route on the env that started the call: handle ours, hand the other env's off + skip.
  const eventEnv =
    (event.data.conversation_initiation_client_data?.dynamic_variables?.app_env as
      | string
      | undefined) ?? "prod";
  if (eventEnv !== appEnv) {
    // Not ours. The one webhook lives on Prod, so relay this to Dev then skip. We do NOT await it:
    // `after()` runs it once the response is flushed (and keeps the serverless function alive until
    // it finishes), so the Dev relay never adds latency to — or otherwise affects — the ack. Prod's
    // OWN calls never reach this branch anyway; the relay is the handler's only Dev dependency.
    if (webhookForwardUrl && !req.headers.get(RELAYED_HEADER)) {
      after(() => relayToDev(req, raw, signature, webhookForwardUrl));
    }
    return json({ ok: true, ignored: `env:${eventEnv}`, env: appEnv });
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

/**
 * Re-POST a verified webhook to the Dev tunnel: same path, identical raw body + signature, so Dev
 * re-verifies the HMAC with the same secret and decides for itself whether to trace it. Best-effort
 * — a down tunnel must never affect the Prod 200 we owe ElevenLabs.
 */
async function relayToDev(
  req: Request,
  raw: string,
  signature: string,
  forwardUrl: string,
): Promise<void> {
  // Everything is inside the try, INCLUDING URL parsing — a malformed ELEVENLABS_WEBHOOK_FORWARD_URL
  // must be swallowed here, never bubble up. This function is contractually no-throw.
  try {
    const target = new URL(new URL(req.url).pathname, forwardUrl).toString();
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": req.headers.get("content-type") ?? "application/json",
        "elevenlabs-signature": signature,
        [RELAYED_HEADER]: "1",
        "ngrok-skip-browser-warning": "true",
      },
      body: raw,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`[elevenlabs-webhook] dev relay -> ${target} returned ${res.status}`);
  } catch (e) {
    console.warn(`[elevenlabs-webhook] dev relay failed:`, e instanceof Error ? e.message : e);
  }
}
