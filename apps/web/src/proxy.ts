import { NextResponse, type NextRequest } from "next/server";
import { auth0 } from "./lib/auth0";

/**
 * Auth gate (Next 16 `proxy` convention). Lets Auth0's own /auth/* routes through. For
 * unauthenticated requests: page routes redirect to login, while `/api/*` routes pass
 * through so their handlers return a proper 401 JSON envelope (a fetch shouldn't be
 * redirected into an HTML login page).
 */
export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const authRes = await auth0.middleware(request);

  const { pathname } = request.nextUrl;

  // Auth0 mounts its routes under /auth (login, logout, callback). The web manifest must also
  // stay public — installers (iOS/Android) fetch it without credentials, so gating it would
  // redirect the fetch into the login page and break "Add to Home Screen". PWA icons already
  // bypass the gate via the `*.png` exclusion in `config.matcher` below.
  //
  // The service worker (`/sw.js`) and its offline shell (`/offline`) must also stay public: the
  // SW is fetched/registered with no guarantee of a validated session, and `/offline` is the
  // credential-less fallback shown when navigations can't reach the network.
  //
  // `/privacy` and `/support` used to be exempt here too — the two URLs App Store Connect requires,
  // opened with no session by the store's link validator and by App Review. Both pages are gone, so
  // whatever URLs are entered in App Store Connect now have to be hosted somewhere else.
  //
  // `/.well-known/*` is public by definition, and nothing lives there today: the RFC 9728 document
  // for `/api/mcp` was deleted when MCP moved to a shared secret
  // (docs/2026-08-27-mcp-static-token-auth.md). The exemption stays anyway, for the failure shape.
  // A client probing for OAuth metadata should get a clean 404 — "there is no authorization server
  // here" — rather than a 307 into an HTML login page, which is a worse thing to hand a JSON parser
  // and a worse thing to read in a client's logs. It is also the standing warning for whatever
  // lands here next (`apple-app-site-association` is the plausible one): this gate ate the metadata
  // document for a whole stage while `/api/mcp` itself looked perfectly healthy.
  if (
    pathname.startsWith("/auth") ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js" ||
    pathname === "/offline"
  ) {
    return authRes;
  }

  const session = await auth0.getSession(request);
  if (!session) {
    // API routes self-report 401; only pages redirect.
    if (pathname.startsWith("/api/")) {
      return authRes;
    }
    return NextResponse.redirect(new URL("/auth/login", request.nextUrl.origin));
  }

  return authRes;
}

export const config = {
  // Run on app + API routes; skip Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)).*)"],
};
