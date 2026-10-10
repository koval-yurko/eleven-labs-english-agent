import { Auth0Client } from "@auth0/nextjs-auth0/server";

/**
 * Auth0 client (SDK v4). Configured from AUTH0_* env. Used by the proxy for route gating, by
 * server code to read the session, and by `lib/api.ts` for the access token it sends to
 * services/api.
 *
 * **AUTH0_AUDIENCE must be the API's audience** (the same value services/api verifies as
 * AUTH0_API_AUDIENCE). It is what makes Auth0 issue a JWT access token the API accepts, so
 * feedback-tracker reaches `/api/v2/*` exactly as the mobile app does. Before the services split this was
 * deliberately left unset, to keep the web login flow untouched; now the web app has no other way
 * to read data. docs/2026-10-10-services-split-hono-api.md §5.1.
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
