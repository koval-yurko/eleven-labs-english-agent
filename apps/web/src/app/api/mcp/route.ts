/**
 * `POST /api/mcp` — the Model Context Protocol server.
 *
 * `/api/mcp`, not `/api/v2/mcp`: `/api/v2` is the NATIVE client's namespace, with its own CORS
 * policy and its own error envelope. MCP has a different envelope (JSON-RPC) and different 401
 * semantics (`WWW-Authenticate` carrying a `resource_metadata` pointer), and mixing them would make
 * the v2 contract in `@tutor/shared/api` describe a route no v2 client will ever call.
 *
 * The tool calls `lib/words.ts` IN-PROCESS rather than fetching our own `/api/v2/lesson-items`. The
 * MCP spec forbids passing a received token to a downstream service, and an internal fetch would be
 * exactly that plus a second network hop for nothing.
 *
 * ⚠️ **S0: this endpoint is UNAUTHENTICATED and refuses to exist unless `MCP_DEV_OWNER_ID` is set
 * outside production.** S1 replaces the guard below with `withMcpAuth(handler, verifyMcpToken, …)`
 * and the RFC 9728 metadata document; nothing else in this file changes. Until then the two lines
 * marked S0 are the only thing standing between this and an open write endpoint, which is why the
 * gate is `mcpDevOwnerId()` — the same function the tool resolves its owner through, so the route
 * cannot be reachable in a state where the tool has no owner.
 *
 * See docs/2026-08-23-mcp-server-add-words.md §3.2 and §9.
 */
import { createMcpHandler } from "mcp-handler";

import { registerAddWords } from "../../../lib/mcp/add-words";
import { mcpDevOwnerId } from "../../../lib/mcp/owner";

// Owner-scoped writes against live data; never cached, and never prerendered.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    registerAddWords(server);
  },
  { serverInfo: { name: "tutor-collection", version: "0.1.0" } },
);

// S0 gate — delete with the `withMcpAuth` wrap in S1.
async function guarded(req: Request): Promise<Response> {
  if (!mcpDevOwnerId()) return new Response("Not found", { status: 404 });
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
