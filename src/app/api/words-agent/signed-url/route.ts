import { elevenLabsConfig } from "../../../../lib/config";
import { json, apiError } from "../../../../lib/http";

/**
 * Mint a short-lived signed WebSocket URL for the English-words-tutor agent. The
 * ELEVENLABS_API_KEY stays server-side — only this signed URL ever reaches the browser, which
 * uses it to open the conversation socket (see src/app/words/WordsTutor.tsx).
 *
 * No auth/persistence by design (docs/2026-06-26-minimal-english-words-voice-agent.md).
 */
export async function GET() {
  const { apiKey, agentId } = elevenLabsConfig();
  if (!apiKey) return apiError(500, "config", "ELEVENLABS_API_KEY is not set.");
  if (!agentId) {
    return apiError(
      500,
      "config",
      "ELEVENLABS_STORY_AGENT_ID is not set — run `pnpm provision:agent` and paste the id.",
    );
  }

  const url =
    "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url" +
    `?agent_id=${encodeURIComponent(agentId)}`;

  try {
    const res = await fetch(url, { headers: { "xi-api-key": apiKey } });
    if (!res.ok) {
      return apiError(502, "elevenlabs", `ElevenLabs returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as { signed_url?: string };
    if (!data.signed_url) {
      return apiError(502, "elevenlabs", "ElevenLabs response had no signed_url.");
    }
    return json({ signedUrl: data.signed_url });
  } catch (e) {
    return apiError(502, "elevenlabs", e instanceof Error ? e.message : String(e));
  }
}
