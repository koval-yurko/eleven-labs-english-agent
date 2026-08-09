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

const DAY = 60 * 60 * 24;

export const auth0 = new Auth0Client({
  ...(audience
    ? { authorizationParameters: { audience, scope: "openid profile email offline_access" } }
    : {}),
  // PWA-friendly session. Installed to the Home Screen, the app should stay signed in across
  // launches instead of re-prompting after the SDK default 1-day inactivity window. Rolling
  // sessions extend on each use, capped by an absolute lifetime.
  session: {
    rolling: true,
    inactivityDuration: 30 * DAY, // logged out only after 30 days of no use
    absoluteDuration: 90 * DAY, // hard cap regardless of activity
    cookie: {
      // Lax is the SDK default and is required for the OAuth callback: the return from Auth0
      // is a top-level GET navigation, which sends Lax cookies (Strict would drop them and
      // break login). Stated explicitly so it is not silently changed.
      sameSite: "lax",
    },
  },
});
