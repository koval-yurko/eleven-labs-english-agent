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
 * **Option B is why the audience here is the same `AUTH0_API_AUDIENCE` the mobile app uses**
 * (docs/2026-08-23-mcp-server-add-words.md §11.2). The consequence, stated where someone changing
 * this will read it: an `/api/mcp` token is also a valid `/api/v2` token. The scope below is the
 * only thing that distinguishes the two directions.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * The scope an MCP client must hold to write words.
 *
 * NOT yet enforced — S1 has no tenant configuration, so no obtainable token can carry it and
 * requiring it would reject every token in existence. S2 defines it as a permission on the Auth0
 * API and turns on `requiredScopes` in the route. Until then it is advertised in the protected
 * resource metadata (which is how a client learns to ask for it) and parsed out of the token here.
 */
export const WORDS_WRITE_SCOPE = "words:write";

const domain = process.env.AUTH0_DOMAIN?.trim();
const audience = process.env.AUTH0_API_AUDIENCE?.trim();

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
      // `resource` is left unset ON PURPOSE. The SDK documents it as "MUST match the MCP server's
      // resource identifier", and under Option B it would not: the token's audience is the shared
      // API, not `…/api/mcp`. Asserting a binding the token does not carry would be a lie in the
      // one field a future reader would trust.
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
