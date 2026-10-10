import { signedUrlV2Path } from "@tutor/shared/api";

import { apiRequest } from "../../../../lib/api";
import { forward } from "../../../../lib/forward";

/**
 * `GET /api/words-agent/signed-url?version=` — the lesson page's ElevenLabs signed WebSocket URL,
 * same-origin so the browser never holds the access token.
 *
 * Forwards to services/api's bearer-authenticated `GET /api/v2/words-agent/signed-url`. Unlike the
 * route this replaces, it is not reachable without a session: no token, no signed URL (the old
 * route minted one for anybody). docs/2026-10-10-services-split-hono-api.md §5.2.
 */
export async function GET(req: Request) {
  const version = new URL(req.url).searchParams.get("version");
  return forward(await apiRequest(signedUrlV2Path(version)));
}
