/**
 * `GET /.well-known/oauth-protected-resource/api/mcp` — the RFC 9728 document for `/api/mcp`.
 *
 * A dot-prefixed directory in the App Router is a corner of Next's file conventions with no
 * explicit documentation, so §3.3 planned a rewrite as the portable fallback. It was tried first
 * and it works; the rewrite is not needed.
 *
 * CORS is wide open here on purpose, and only here: the document is public metadata by definition,
 * and browser-based MCP clients preflight it before the handshake can start.
 */
import { metadataCorsOptionsRequestHandler } from "mcp-handler";

import { mcpProtectedResourceMetadata } from "../../../../../lib/mcp/metadata";

// The document is read from the environment, not the request — but it must still be served fresh,
// because a deployment that changes MCP_RESOURCE_URL must not be answered from a build-time cache.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(mcpProtectedResourceMetadata(), {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "max-age=3600",
    },
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
