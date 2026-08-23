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
 * `withMcpAuth` is what makes the 401 spec-shaped: it answers an unauthenticated request with
 * `WWW-Authenticate: Bearer resource_metadata="…"`, which is the thread a client pulls to discover
 * Auth0 and start the OAuth flow. `required: true` — there is no anonymous mode.
 *
 * See docs/2026-08-23-mcp-server-add-words.md §3.2 and §9.
 */
import { createMcpHandler, withMcpAuth } from "mcp-handler";

import { registerAddWords } from "../../../lib/mcp/add-words";
import { verifyMcpToken } from "../../../lib/mcp/auth";
import { MCP_RESOURCE_METADATA_PATH } from "../../../lib/mcp/metadata";

// Owner-scoped writes against live data; never cached, and never prerendered.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    registerAddWords(server);
  },
  { serverInfo: { name: "tutor-collection", version: "0.1.0" } },
);

/**
 * `requiredScopes: [WORDS_WRITE_SCOPE]` belongs here and is deliberately absent until S2 — the
 * tenant defines no such permission yet, so every obtainable token would be rejected with a 403.
 * Adding it is the one-line change that completes §11.2's asymmetry.
 */
const authed = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  resourceMetadataPath: MCP_RESOURCE_METADATA_PATH,
});

export { authed as GET, authed as POST, authed as DELETE };
