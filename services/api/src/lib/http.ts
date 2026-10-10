import type { ApiErrorBody } from "@tutor/shared/api";

/**
 * Standard JSON responses + error envelope. The shapes themselves live in `packages/shared/src/api.ts`
 * so any client can name them; this module builds the responses.
 *
 * The same API the Next app's `lib/http.ts` had, on the Web-standard `Response` instead of
 * `NextResponse` — so a route ported from the Next app keeps its body unchanged and its responses
 * byte-for-byte equal (docs/2026-10-10-services-split-hono-api.md §4.2).
 */

export function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}

export function apiError(status: number, code: string, message: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return Response.json(body, { status });
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
 * and nothing else, and the header is illegal beside `origin: *`. `*` without credentials grants a
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

/** The `OPTIONS` handler every v2 route re-exports. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Copy the CORS headers onto an existing response. Applied to EVERY v2 response including errors —
 * a 401 without them reads in a browser console as a network failure instead of as the 401 it is.
 */
export function withCors(res: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.headers.set(key, value);
  return res;
}
