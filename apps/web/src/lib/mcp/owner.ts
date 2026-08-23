/**
 * Who an MCP tool writes as.
 *
 * ⚠️ **S0 — the unauthenticated stage.** Until S1 lands there is no token: the owner comes from
 * `MCP_DEV_OWNER_ID`, an Auth0 `sub` pasted into `.env.local`. This is the whole reason
 * `mcpDevOwnerId()` also gates the route (`app/api/mcp/route.ts`) — an unauthenticated write
 * endpoint must be impossible to deploy, not merely unlikely to be.
 *
 * The order below is already the S1 order, so S1 adds `withMcpAuth` and deletes the route's guard
 * without touching this file: a verified token wins, the dev fallback only exists where there can
 * be no token, and a server with neither throws rather than guessing an owner.
 *
 * See docs/2026-08-23-mcp-server-add-words.md §9.
 */
import type { ServerContext } from "@modelcontextprotocol/server";

/**
 * The dev owner, or null — null in production ALWAYS, whatever the environment says.
 *
 * `NODE_ENV` rather than the app's own env flag on purpose: this is a build-time constant Next
 * inlines, so the production branch is not something a misconfigured deployment can talk its way
 * out of.
 */
export function mcpDevOwnerId(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const sub = process.env.MCP_DEV_OWNER_ID?.trim();
  return sub && sub.length > 0 ? sub : null;
}

/**
 * Resolve the learner whose collection this call writes to, or throw.
 *
 * Throwing is the right failure: the SDK turns it into a tool error the caller can read, and every
 * alternative — a default owner, a silent no-op — writes somebody's words somewhere unintended.
 */
export function mcpOwnerId(ctx: ServerContext): string {
  const fromToken = ctx.http?.authInfo?.extra?.ownerId;
  if (typeof fromToken === "string" && fromToken.length > 0) return fromToken;

  const dev = mcpDevOwnerId();
  if (dev) return dev;

  throw new Error(
    "No authenticated owner. Set MCP_DEV_OWNER_ID for local S0 use, or connect with a token.",
  );
}
