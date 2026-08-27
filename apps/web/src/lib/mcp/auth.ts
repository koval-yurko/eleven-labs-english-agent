/**
 * Bearer verification for `/api/mcp` — a SIBLING of `lib/auth/bearer.ts`, deliberately not a
 * parameterization of it.
 *
 * `withBearer` is the one cookie-free path for the native client, and that separation is the whole
 * reason `/api/v2` exists. Threading a second audience and a scope check through it is how the
 * separation starts to erode; twenty duplicated lines is the cheaper price.
 *
 * Everything security-relevant is copied on purpose, not by accident: the module-scope
 * `createRemoteJWKSet` (it caches the tenant's keys and handles rotation — rebuilding per request
 * defeats both), the trailing slash on the issuer (Auth0's `iss` has one, and without it every
 * token fails while looking perfectly valid decoded by eye), the pinned `RS256` (left open, a token
 * nominates its own `alg`), and the fail-CLOSED rule when the server is misconfigured.
 *
 * **The audience is `MCP_RESOURCE_URL`, NOT `AUTH0_API_AUDIENCE`** — Option A
 * (docs/2026-08-23-mcp-server-add-words.md §11.6). That one difference is the whole point: the MCP
 * server has its own Auth0 API whose identifier IS its canonical URL, so `aud` equals the RFC 8707
 * resource the client asked for, and the two directions are closed by cryptography rather than by
 * convention. A phone token cannot drive `/api/mcp` and an MCP token cannot drive `/api/v2`,
 * because neither carries the other's audience.
 *
 * Do not "simplify" this back to the shared audience. Under the shared one, the token handed to
 * Claude is a whole-API credential, and only a scope check the v2 routes do not perform stands
 * between it and the learner's entire collection.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * The scope an MCP client must hold to write words.
 *
 * Defence in depth under Option A rather than the only boundary: the audience already separates
 * this server from `/api/v2`. Its real work starts with the second tool, when `words:read` has to
 * be a different grant from `words:write` (§11.4).
 *
 * Advertised in the protected resource metadata, which is how a client learns to ask for it.
 */
export const WORDS_WRITE_SCOPE = "words:write";

const domain = process.env.AUTH0_DOMAIN?.trim();

/**
 * The MCP server's own Auth0 API identifier — the same string as its RFC 9728 `resource`, by
 * construction. One variable rather than two so they cannot drift: a `resource` the clients accept
 * but Auth0 does not know, or an `aud` no client asked for, are both silent failures.
 */
const audience = process.env.MCP_RESOURCE_URL?.trim();

const jwks = domain
  ? createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  : null;

/**
 * `verifyToken` for `withMcpAuth`: an `AuthInfo` for a good token, `undefined` for anything else.
 *
 * **Returning rather than throwing is deliberate.** `withMcpAuth` catches a throw, logs
 * `console.error("Unexpected error authenticating bearer token")` and returns the same 401 — so a
 * throw buys nothing and turns every unauthenticated probe (of which there is one at the start of
 * every OAuth handshake, by design) into a server error line. Same reasoning as `getBearerOwnerId`:
 * a caller has nothing to do with the distinction between failures, and reporting which check
 * failed tells an attacker which one to fix.
 */
export async function verifyMcpToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!jwks || !audience || !bearerToken) return undefined; // misconfigured server fails CLOSED

  try {
    const { payload } = await jwtVerify(bearerToken, jwks, {
      issuer: `https://${domain}/`,
      audience,
      algorithms: ["RS256"],
    });

    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0) return undefined;

    return {
      token: bearerToken,
      // Auth0 puts the requesting client in `azp`. `withMcpAuth` requires the field but never reads
      // it; it exists so a log line can say WHICH client wrote, once there is more than one.
      clientId: typeof payload.azp === "string" ? payload.azp : "",
      scopes: parseScopes(payload.scope),
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      // `resource` is left unset because nothing in this stack reads it: `withMcpAuth` does not,
      // and the SDK's own `requireBearerAuth` (which does, via `checkResourceAllowed`) is not on
      // this path. Under Option A the binding it would assert is true — `aud` IS the resource — so
      // this is a "no reader" decision, not a correctness one. Set it if that ever changes.
      extra: { ownerId: sub },
    };
  } catch {
    return undefined;
  }
}

/**
 * Scopes come from the OAuth `scope` claim and NOWHERE ELSE.
 *
 * Auth0 also exposes granted RBAC permissions in a `permissions` array, and merging it in looks
 * like a harmless robustness fix. It is not: mobile logs in with
 * `openid profile email offline_access` and never REQUESTS `words:write`, which is precisely what
 * stops a phone token from driving this endpoint. An RBAC permission is attached to the user, so it
 * would ride on every token the learner holds and erase that boundary — the only asymmetry Option B
 * leaves us (§11.2).
 */
function parseScopes(claim: unknown): string[] {
  return typeof claim === "string" ? claim.split(" ").filter((s) => s.length > 0) : [];
}
