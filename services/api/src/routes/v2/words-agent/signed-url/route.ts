import { elevenLabsConfig } from "@tutor/server/config";
import { resolveAgent } from "@tutor/server/agent-registry";
import type { SignedUrlResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../lib/http";

export const OPTIONS = preflight;

/**
 * `GET /api/v2/words-agent/signed-url?version=` — a short-lived signed WebSocket URL for a tutor
 * version's ElevenLabs agent. The bearer-authenticated successor to `/api/words-agent/signed-url`,
 * for tutor-web's lesson page (which connects over WebSocket; the native app uses the WebRTC
 * `token` route instead).
 *
 * Ported from the Next app's v1 route with one deliberate change: **it requires a bearer token.**
 * The v1 route had no check of its own and the web auth gate let every `/api/*` request through
 * unauthenticated (routes were meant to 401 themselves), so anyone could mint signed URLs on our
 * ElevenLabs key. tutor-web reaches this through its own same-origin route, which attaches the
 * signed-in learner's token. docs/2026-10-10-services-split-hono-api.md §5.2.
 *
 * With no `version`, the newest active version is used. ELEVENLABS_API_KEY stays here — only the
 * signed URL reaches the browser.
 */
export const GET = withBearer(async (req) => {
  const { apiKey, appEnv } = elevenLabsConfig();
  if (!apiKey) return apiError(500, "config", "ELEVENLABS_API_KEY is not set.");

  const requested = new URL(req.url).searchParams.get("version");
  const agent = resolveAgent(requested);
  if (!agent) {
    return apiError(
      requested ? 400 : 500,
      "config",
      requested
        ? `Unknown or inactive tutor version "${requested}".`
        : "No active tutor agents — run `pnpm sync:agents` to provision them.",
    );
  }

  const url =
    "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url" +
    `?agent_id=${encodeURIComponent(agent.agentId)}`;

  try {
    const res = await fetch(url, { headers: { "xi-api-key": apiKey } });
    if (!res.ok) {
      return apiError(502, "elevenlabs", `ElevenLabs returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as { signed_url?: string };
    if (!data.signed_url) {
      return apiError(502, "elevenlabs", "ElevenLabs response had no signed_url.");
    }
    // appEnv is echoed back so the client stamps it onto the conversation (app_env dynamic
    // variable) — the post-call webhook reads it to route the event to the right env.
    const body: SignedUrlResponse = { signedUrl: data.signed_url, version: agent.version, appEnv };
    return json(body);
  } catch (e) {
    return apiError(502, "elevenlabs", e instanceof Error ? e.message : String(e));
  }
});
