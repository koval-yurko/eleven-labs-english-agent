import type { ConversationTokenResponse } from "@tutor/shared/api";

import { resolveAgent } from "../../../../../lib/agent-registry";
import { withBearer } from "../../../../../lib/auth/bearer";
import { elevenLabsConfig } from "../../../../../lib/config";
import { apiError, json, preflight } from "../../../../../lib/http";

// Read the registry at request time, not build time (the lockfile may change between deploys).
export const dynamic = "force-dynamic";

// D25 — without this a browser preflight gets 405 and the real request is never sent.
export const OPTIONS = preflight;

/**
 * `POST /api/v2/words-agent/token` — the WebRTC twin of `/api/words-agent/signed-url`.
 *
 * React Native cannot use the signed-URL path at all (the SDK throws for `connectionType:
 * "websocket"`, structurally — that transport needs Web Audio), so the native client gets a
 * conversation token instead. The ELEVENLABS_API_KEY stays server-side either way, and the agent id
 * NEVER reaches the app: the client names a version, this route resolves version → agent.
 *
 * POST rather than GET because the call MINTS a conversation — it is not a cacheable read and no
 * proxy should treat it as one. The version rides in the query string so the route shares
 * `signedUrlPath`'s grammar (`conversationTokenPath`) and needs no body parsing.
 *
 * See docs/2026-08-13-expo-s3-conversation-token.md §5.2.
 */
export const POST = withBearer(async (req) => {
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

  try {
    const res = await fetch(
      "https://api.elevenlabs.io/v1/convai/conversation/token" +
        `?agent_id=${encodeURIComponent(agent.agentId)}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!res.ok) {
      return apiError(502, "elevenlabs", `ElevenLabs returned HTTP ${res.status}`);
    }

    // Read as a bare shape and assert both fields ourselves. The typed SDK method
    // (`conversationalAi.conversations.getWebrtcToken`) is deliberately NOT used: its generated
    // `TokenResponseModel` declares `{ token }` only, so `conversation_id` — the value this whole
    // stage rests on — would arrive untyped through a passthrough validator, invisible to tsc.
    const data = (await res.json()) as { token?: string; conversation_id?: string };
    if (!data.token) {
      return apiError(502, "elevenlabs", "ElevenLabs response had no token.");
    }
    // A DERIVED id is worse than no session: it silently forks a learner's history weeks before
    // anyone notices, whereas a refused session is visible and correctable now. Never fall back.
    if (!data.conversation_id) {
      return apiError(502, "elevenlabs", "ElevenLabs response had no conversation_id.");
    }

    // appEnv is echoed so the client stamps it onto the conversation (the `app_env` dynamic
    // variable) — the post-call webhook reads it to route the event to the right environment.
    const body: ConversationTokenResponse = {
      token: data.token,
      conversationId: data.conversation_id,
      version: agent.version,
      appEnv,
    };
    return json(body);
  } catch (e) {
    return apiError(502, "elevenlabs", e instanceof Error ? e.message : String(e));
  }
});
