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
import { WORDS_WRITE_SCOPE, verifyMcpToken } from "../../../lib/mcp/auth";
import { MCP_RESOURCE_METADATA_PATH } from "../../../lib/mcp/metadata";

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
     * vocabulary in the caller's own collection, and nothing else. Three lines are worth knowing
     * before they are crossed, because each one changes the CLASS of the server rather than its
     * size (docs/2026-08-23-mcp-server-add-words.md §8.2, §11.4):
     *
     * 1. **The first read tool makes this an exfiltration channel.** `list_words`, `search_words`,
     *    ChatGPT's `search`/`fetch` pair — any of them lets the learner's collection leave the
     *    account and enter a model context someone else may be steering. That is a different
     *    review, not a bigger version of this one.
     * 2. **A delete tool crosses irreversibility.** `deleteWord` already exists in `lib/words.ts`
     *    and would be four lines here. Client-side confirmation (ChatGPT's per-conversation
     *    prompt, Claude's per-tool approval) is a UX affordance, not a guarantee, and it is the
     *    only thing that would stand between a model and destroying vocabulary.
     * 3. **Mint the scope with the tool, not after.** `words:read` must be a grant the learner can
     *    withhold from a client that only needs to write; one omnibus scope erases the only
     *    granularity the design has. Add the permission to the Auth0 API, list it in
     *    `scopes_supported` (`lib/mcp/metadata.ts`), and gate it — `requiredScopes` below is
     *    per-server, so a read tool needs its own check inside the tool.
     */
    registerAddWords(server);
  },
  { serverInfo: { name: "tutor-collection", version: "0.1.0" } },
);

/**
 * The scope is defence in depth, not the boundary — under Option A the audience already separates
 * this server from `/api/v2` (§11.6). It earns its keep with the second tool, when `words:read`
 * must be a grant a learner can withhold from a client that only needs to write.
 *
 * A 403 here reports `scope="words:write"` in the `WWW-Authenticate` header, which is how a client
 * that asked for too little learns what to ask for.
 */
const authed = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  resourceMetadataPath: MCP_RESOURCE_METADATA_PATH,
  requiredScopes: [WORDS_WRITE_SCOPE],
});

export { authed as GET, authed as POST, authed as DELETE };
