import { auth0 } from "../auth0";

/**
 * Resolve the authenticated learner's stable id (Auth0 `sub`) for owner scoping.
 * Returns null when unauthenticated. Isolated here so callers depend on a small surface
 * that is easy to stub in tests.
 */
export async function getOwnerId(): Promise<string | null> {
  const session = await auth0.getSession();
  return session?.user?.sub ?? null;
}

/** The authenticated learner's email (for display only). */
export async function getUserEmail(): Promise<string | null> {
  const session = await auth0.getSession();
  return session?.user?.email ?? null;
}

/** The Auth0 access token, used to scope the Supabase client to the learner (RLS). */
export async function getAuthToken(): Promise<string | null> {
  try {
    const { token } = await auth0.getAccessToken();
    return token ?? null;
  } catch {
    return null;
  }
}
