/**
 * `POST /api/mcp` — the Model Context Protocol server.
 *
 * `/api/mcp`, not `/api/v2/mcp`: `/api/v2` is the NATIVE client's namespace, with its own CORS
 * policy and its own error envelope. MCP has a different envelope (JSON-RPC) and different 401
 * semantics, and mixing them would make the v2 contract in `@tutor/shared/api` describe a route no
 * v2 client will ever call.
 *
 * The tool calls `lib/words.ts` IN-PROCESS rather than fetching our own `/api/v2/lesson-items`. The
 * MCP spec forbids passing a received token to a downstream service, and an internal fetch would be
 * exactly that plus a second network hop for nothing.
 *
 * **Authorization is one shared secret** (`lib/mcp/auth.ts`), not OAuth. Swapped 2026-08-27; see
 * docs/2026-08-27-mcp-static-token-auth.md. Two things about the 401 below are load-bearing:
 *
 *  1. **It carries no `resource_metadata` pointer.** There is no authorization server to discover,
 *     and a pointer to one is what pulls a client that was configured with a static header into an
 *     OAuth flow instead — the shape of `anthropics/claude-code#59467`, where a server advertising
 *     both connects "successfully" and exposes synthetic `authenticate` tools rather than its own.
 *  2. **`withMcpAuth` cannot be used to produce it.** Reading `mcp-handler@2.1.1`, the wrapper
 *     builds `resourceMetadataUrl` before it even parses the token and attaches it to every
 *     failure; there is no option that omits it. Keeping the wrapper while deleting the metadata
 *     document would 401 with a pointer at a URL that 404s, which is worse than either.
 */
import { createMcpHandler } from "mcp-handler";

import { registerAddWords } from "../../../lib/mcp/add-words";
import { mcpTokenOk } from "../../../lib/mcp/auth";

// Owner-scoped writes against live data; never cached, and never prerendered.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    /**
     * ─── Read this before adding the second tool. ────────────────────────────────────────────
     *
     * This server is WRITE-ONLY AND BLIND, and that is what makes its threat model small enough to
     * state in a sentence: a prompt injection that reaches `add_words_to_collection` can put junk
     * vocabulary in one known collection, and nothing else. Three lines are worth knowing before
     * they are crossed, because each one changes the CLASS of the server rather than its size
     * (docs/2026-08-23-mcp-server-add-words.md §8.2, §11.4):
     *
     * 1. **The first read tool makes this an exfiltration channel.** `list_words`, `search_words`,
     *    ChatGPT's `search`/`fetch` pair — any of them lets the learner's collection leave the
     *    account and enter a model context someone else may be steering. That is a different
     *    review, not a bigger version of this one.
     * 2. **A delete tool crosses irreversibility.** `deleteWord` already exists in `lib/words.ts`
     *    and would be four lines here. Client-side confirmation (ChatGPT's per-conversation
     *    prompt, Claude's per-tool approval) is a UX affordance, not a guarantee, and it is the
     *    only thing that would stand between a model and destroying vocabulary.
     * 3. **Under one shared secret, a new permission is a new TOKEN — or it does not exist.** The
     *    OAuth build could mint `words:read` as a scope the learner withholds from a client that
     *    only needs to write. There are no scopes now: no `requiredScopes`, no
     *    `ctx.http.authInfo.scopes` to test. So a read tool added here is reachable by every client
     *    already holding `MCP_TOKEN`, retroactively. Gating it means a second secret with its own
     *    owner resolution, which is a design decision, not an `if`.
     */
    registerAddWords(server);
  },
  { serverInfo: { name: "tutor-collection", version: "0.1.0" } },
);

async function authed(req: Request): Promise<Response> {
  if (mcpTokenOk(req)) return handler(req);

  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      // RFC 6750 challenge, deliberately WITHOUT `resource_metadata=` — see the header comment.
      "www-authenticate": 'Bearer error="invalid_token"',
    },
  });
}

export { authed as GET, authed as POST, authed as DELETE };
