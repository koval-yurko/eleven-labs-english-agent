import { Auth0Client } from "@auth0/nextjs-auth0/server";

/**
 * Auth0 client (SDK v4). Configured from AUTH0_* env. Used by the proxy/middleware for
 * route gating and by server code to read the authenticated session.
 *
 * When AUTH0_AUDIENCE is set, request that API audience so Auth0 issues a JWT access token
 * usable for Supabase third-party auth / RLS. Left unset, login behaves as before (opaque
 * token) — so this is safe to enable only once the Auth0 API + Supabase trust are configured
 * (see supabase/README.md).
 */
const audience = process.env.AUTH0_AUDIENCE?.trim();
export const auth0 = new Auth0Client(
  audience
    ? { authorizationParameters: { audience, scope: "openid profile email offline_access" } }
    : {},
);
