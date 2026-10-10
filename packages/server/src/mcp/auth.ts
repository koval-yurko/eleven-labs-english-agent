/**
 * Bearer verification for `/api/mcp` — one shared secret, compared in constant time.
 *
 * This replaced an Auth0 JWT path (JWKS, RS256, `iss`, `aud`, `scope`) on 2026-08-27. The reasoning
 * for the swap, and the client-compatibility it costs, is
 * docs/2026-08-27-mcp-static-token-auth.md; what matters here is the shape it leaves behind.
 *
 * **This module answers ONE question — is this request carrying the secret — and returns a boolean.**
 * It deliberately does not build an `AuthInfo`, does not resolve an owner, and attaches nothing to
 * the request. With a single shared secret the owner does not vary per call, so threading one
 * through `AuthInfo.extra` → `req.auth` → `ctx.http.authInfo` would be six links carrying a
 * constant. The owner is read once where it is used (`lib/mcp/add-words.ts`).
 *
 * It stays a SIBLING of `lib/auth/bearer.ts` rather than a parameterization of it, for the same
 * reason it always was: `withBearer` is the one cookie-free path for the native client, and that
 * separation is the whole reason `/api/v2` exists. The two now share nothing but a header name —
 * `/api/v2` verifies an Auth0 JWT, this verifies a secret — which is itself the boundary: the
 * static token is not a JWT, so `jwtVerify` rejects it and an MCP credential remains useless
 * anywhere else in the app.
 *
 * Do NOT add a second way in. No `?token=` (the MCP spec forbids access tokens in the query string,
 * and URLs land in proxy logs, server logs and browser history), no `X-Api-Key` alias, no
 * "temporarily also accept a JWT".
 */
import { createHash, timingSafeEqual } from "node:crypto";

const current = process.env.MCP_TOKEN?.trim();

/** Set only during a rotation; accepted alongside `MCP_TOKEN` until every client has moved over. */
const previous = process.env.MCP_TOKEN_OLD?.trim();

/**
 * Digests, not the secrets themselves: `timingSafeEqual` THROWS on a length mismatch, which would
 * turn the token's length into something an attacker can read off a stack trace. SHA-256 makes
 * every comparison exactly 32 bytes.
 *
 * The 32-character floor treats a placeholder (`changeme`, `test`) as if the variable were unset. A
 * short token is not a weaker deployment, it is a broken one, and failing closed is the only honest
 * response.
 */
const accepted = [current, previous]
  .filter((t): t is string => typeof t === "string" && t.length >= 32)
  .map(digest);

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * `reduce`, not `some`: every candidate is compared whether or not an earlier one matched, so the
 * response time cannot say WHICH secret was presented — the current one or the one being rotated
 * out.
 */
function matches(presented: string): boolean {
  const d = digest(presented);
  return accepted.reduce<boolean>((ok, a) => timingSafeEqual(d, a) || ok, false);
}

// One line at module scope, and no secret in it. There is no metadata route left to fail loudly
// (the OAuth build had one, and its 500 was the half that said what was wrong), so without this a
// misconfigured deployment is a permanent silent 401 with nothing anywhere to explain it.
if (accepted.length === 0) {
  console.warn("[mcp] MCP_TOKEN unset or shorter than 32 chars; /api/mcp rejects every request.");
}

/**
 * Is this request carrying the shared secret? That is the entire authorization model.
 *
 * Returning rather than throwing, and one undifferentiated `false` for every failure — no header,
 * wrong scheme, wrong secret — is the same rule `getBearerOwnerId` follows: a caller has nothing to
 * do with the distinction, and reporting which check failed tells an attacker which one to fix. An
 * unauthenticated probe is also a normal event, not a server error.
 */
export function mcpTokenOk(req: Request): boolean {
  if (accepted.length === 0) return false; // misconfigured server fails CLOSED

  const [scheme, value] = req.headers.get("authorization")?.split(" ") ?? [];
  if (scheme?.toLowerCase() !== "bearer" || !value) return false;

  return matches(value);
}
