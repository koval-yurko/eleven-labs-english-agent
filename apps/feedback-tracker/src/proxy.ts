import { NextResponse, type NextRequest } from "next/server";
import { auth0 } from "./lib/auth0";

/**
 * Auth gate (Next 16 `proxy` convention). Auth0's own `/auth/*` routes pass through; every other
 * request without a session is sent to log in. There are no API routes here — data comes from
 * services/api, fetched server-side with the session's access token (`lib/api.ts`).
 */
export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const authRes = await auth0.middleware(request);
  if (request.nextUrl.pathname.startsWith("/auth")) return authRes;

  const session = await auth0.getSession(request);
  if (!session) return NextResponse.redirect(new URL("/auth/login", request.nextUrl.origin));
  return authRes;
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)).*)"],
};
