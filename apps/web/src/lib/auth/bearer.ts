import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NextResponse } from "next/server";

import { unauthorized, withCors } from "../http";

/**
 * Bearer authentication for the `/api/v2/*` namespace — the native client's path, and ONLY the
 * native client's path.
 *
 * `getOwnerId()` (lib/auth/session.ts) stays cookie-only and is not touched. That separation is the
 * whole reason `/api/v2` exists: there is no shared auth branch for the web app to regress through.
 * See docs/2026-08-12-expo-app-creation.md §3.1 and docs/2026-08-13-expo-s2-auth0-bearer.md.
 */

const domain = process.env.AUTH0_DOMAIN?.trim();

/**
 * VERIFICATION ONLY, and deliberately NOT `AUTH0_AUDIENCE`.
 *
 * `lib/auth0.ts` reads `AUTH0_AUDIENCE` and, when set, adds `authorizationParameters` to the WEB
 * Auth0 client — changing the web login flow. The server never needs to REQUEST an audience in
 * order to VERIFY one: the mobile app asks for it via `authorize({ audience })`, and we only need
 * the identifier as a string to check the `aud` claim.
 */
const audience = process.env.AUTH0_API_AUDIENCE?.trim();

/**
 * Module scope on purpose: `createRemoteJWKSet` caches the tenant's signing keys and handles
 * rotation and fetch cooldown itself. Rebuilding it per request would re-fetch JWKS on every call
 * and defeat both.
 */
const jwks = domain
  ? createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
  : null;

/**
 * Resolve the learner's stable id (Auth0 `sub`) from a Bearer access token, or null.
 *
 * Every failure — missing header, wrong scheme, bad signature, expired, wrong audience, malformed —
 * collapses to null on purpose: a caller has nothing useful to do with the distinction, and
 * reporting which check failed tells an attacker which one to fix.
 */
export async function getBearerOwnerId(req: Request): Promise<string | null> {
  if (!jwks || !audience) return null; // misconfigured server fails CLOSED, never open

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  try {
    const { payload } = await jwtVerify(header.slice("Bearer ".length), jwks, {
      // Auth0's `iss` carries a TRAILING SLASH. Without it every token fails verification while
      // looking perfectly valid when decoded by eye.
      issuer: `https://${domain}/`,
      audience,
      // Pin the algorithm. Left open, a token can nominate its own `alg` — the classic JWT
      // confusion attack. One line.
      algorithms: ["RS256"],
    });
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * Wrap a v2 route handler so it cannot be written without an authenticated owner.
 *
 * A wrapper rather than a per-route call, deliberately: a route that forgot the check would serve
 * another learner's rows, it would fail OPEN, and it would look finished. Here the handler's
 * signature makes "forgot to authenticate" inexpressible.
 *
 * It is also the single place CORS is applied (D25) — including to the 401, so a browser sees the
 * status rather than an opaque network error. Routes still re-export `OPTIONS = preflight` for the
 * preflight itself, which never reaches a handler.
 */
export function withBearer(
  handler: (req: Request, ownerId: string) => Promise<NextResponse>,
): (req: Request) => Promise<NextResponse> {
  return async (req: Request) => {
    const ownerId = await getBearerOwnerId(req);
    if (!ownerId) return withCors(unauthorized());
    return withCors(await handler(req, ownerId));
  };
}
