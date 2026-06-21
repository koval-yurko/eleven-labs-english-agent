/**
 * Mint a short-lived ElevenLabs conversation token for the live-tutor agent (research R1).
 * SERVER-ONLY: the `xi-api-key` stays here and never reaches the browser (Constitution V);
 * the browser receives only the returned token. `fetchImpl` is injectable for tests.
 */
export type TokenFetch = typeof fetch;

interface MintedToken {
  conversationToken: string;
  connectionType: "webrtc";
}

const TOKEN_ENDPOINT = "https://api.elevenlabs.io/v1/convai/conversation/token";

export async function mintConversationToken(
  apiKey: string,
  agentId: string,
  fetchImpl: TokenFetch = fetch,
): Promise<MintedToken> {
  const url = `${TOKEN_ENDPOINT}?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetchImpl(url, { headers: { "xi-api-key": apiKey } });
  if (!res.ok) {
    throw new Error(`conversation token mint failed: ${res.status}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error("conversation token mint returned no token");
  }
  return { conversationToken: data.token, connectionType: "webrtc" };
}
