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
  if (
    pathname.startsWith("/auth") ||
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
