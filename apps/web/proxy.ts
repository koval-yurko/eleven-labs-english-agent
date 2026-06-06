import { NextResponse, type NextRequest } from "next/server";
import { auth0 } from "./lib/auth0";

/**
 * Auth gate (T011, FR-017) — Next 16 `proxy` convention. Lets Auth0's own /auth/*
 * routes through, then requires a session for everything else, redirecting
 * unauthenticated visitors to login.
 */
export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const authRes = await auth0.middleware(request);

  // Auth0 mounts its routes under /auth (login, logout, callback).
  if (request.nextUrl.pathname.startsWith("/auth")) {
    return authRes;
  }

  const session = await auth0.getSession(request);
  if (!session) {
    return NextResponse.redirect(new URL("/auth/login", request.nextUrl.origin));
  }

  return authRes;
}

export const config = {
  // Run on app + API routes; skip Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)).*)"],
};
