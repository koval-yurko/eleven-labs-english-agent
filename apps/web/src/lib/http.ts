import { NextResponse } from "next/server";
import type { ApiErrorBody } from "@tutor/shared/api";

/**
 * Standard JSON responses + error envelope. The shapes themselves live in `packages/shared/src/api.ts`
 * so any client can name them; this module is the Next-specific half that builds the responses.
 */

export function json<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function apiError(status: number, code: string, message: string): NextResponse {
  const body: ApiErrorBody = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export const unauthorized = () =>
  apiError(401, "unauthenticated", "You must be signed in to do that.");

/**
 * CORS for the `/api/v2/*` namespace only — applied by `withBearer`, never by a route by hand.
 *
 * A React Native `fetch` is NOT a browser: it sends no `Origin` and applies no same-origin policy,
 * so none of this is what makes the iOS app work. It is here because `react-native-web` is in the
 * mobile app's dependency set (`expo start --web` renders the same screens in a real browser, where
 * every v2 call IS cross-origin and DOES preflight), and because a browser console is the fastest
 * way to probe the deployed API while building.
 *
 * `access-control-allow-credentials` is deliberately absent. v2 authenticates with a Bearer token
 * and nothing else, the header is illegal beside `origin: *`, and it is the one line that could
 * make the COOKIE-authenticated surface reachable cross-origin. `*` without credentials grants a
 * third-party page nothing it did not already have: it still needs a token it cannot obtain.
 *
 * See docs/2026-08-13-expo-s3-conversation-token.md D25.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
};

/**
 * The `OPTIONS` handler every v2 route re-exports.
 *
 * Required, not optional: a Next route handler with no `OPTIONS` export answers 405, and the
 * browser then fails the preflight before it ever sends the real request — which surfaces as an
 * opaque network error rather than as anything mentioning CORS.
 */
export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Copy the CORS headers onto an existing response. Applied to EVERY v2 response including errors —
 * a 401 without them reads in a browser console as a network failure instead of as the 401 it is.
 */
export function withCors(res: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.headers.set(key, value);
  return res;
}
