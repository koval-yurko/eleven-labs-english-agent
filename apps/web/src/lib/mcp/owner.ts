/**
 * Who an MCP tool writes as: the `sub` from the verified access token, or nothing.
 *
 * There is no fallback and no default. S0 had one — `MCP_DEV_OWNER_ID`, gated to non-production —
 * and it was deleted with the arrival of `withMcpAuth` rather than kept "for convenience in dev".
 * A fallback under a `required: true` auth wrap is unreachable in the normal case and a silent
 * mis-write in the abnormal one, which is the worst pair of properties a code path can have.
 * Pasting a token is the dev workflow now (docs/2026-08-23-mcp-server-add-words.md §11.3).
 */
import type { ServerContext } from "@modelcontextprotocol/server";

/**
 * Resolve the learner whose collection this call writes to, or throw.
 *
 * Throwing is the right failure: the SDK turns it into a tool error the caller can read, and every
 * alternative — a default owner, a silent no-op — writes somebody's words somewhere unintended.
 *
 * In practice `withMcpAuth` has already rejected an unauthenticated request before a tool runs, so
 * this throw fires only if the route is ever wired without it. That is exactly when it should.
 */
export function mcpOwnerId(ctx: ServerContext): string {
  const ownerId = ctx.http?.authInfo?.extra?.ownerId;
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new Error("No authenticated owner on the request.");
  }
  return ownerId;
}
