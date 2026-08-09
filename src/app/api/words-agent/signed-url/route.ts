import { elevenLabsConfig } from "../../../../lib/config";
import { resolveAgent } from "../../../../lib/agent-registry";
import { json, apiError } from "../../../../lib/http";
import type { SignedUrlResponse } from "../../../../shared/api";

// Read the registry at request time, not build time (the lockfile may change between deploys).
export const dynamic = "force-dynamic";

/**
 * Mint a short-lived signed WebSocket URL for a chosen tutor version's agent. The version is
 * picked in the UI (`?version=words-1.1`); with none, the newest active version is used. The
 * version→agent_id map lives in the committed lockfile (src/agent/agents.lock.json, written by
 * `pnpm sync:agents`). The ELEVENLABS_API_KEY stays server-side — only the signed URL reaches
 * the browser (see src/app/words/WordsTutor.tsx).
 *
 * No auth/persistence by design (docs/2026-06-26-minimal-english-words-voice-agent.md).
 */
export async function GET(req: Request) {
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
    const body: SignedUrlResponse = {
      signedUrl: data.signed_url,
      version: agent.version,
      appEnv,
    };
    return json(body);
  } catch (e) {
    return apiError(502, "elevenlabs", e instanceof Error ? e.message : String(e));
  }
}
