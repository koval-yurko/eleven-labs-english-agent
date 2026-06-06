import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAuthToken } from "../auth/session";

/**
 * Auth0-token-scoped Supabase client (T037). Forwards the learner's Auth0 access token
 * so Postgres RLS (`auth.jwt() ->> 'sub'`) governs access — the live "second layer"
 * beyond the repository's explicit owner filtering.
 *
 * ACTIVATION (manual, one-time): this only enforces ownership once Supabase is
 * configured to trust the Auth0 issuer as a third-party auth provider AND Auth0 issues
 * a JWT access token (an API audience + a `role: "authenticated"` claim). Until then,
 * privacy is enforced by the service-role repository's explicit `owner_id` filtering.
 * Full steps: supabase/README.md §T037.
 */
export function getUserSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Supabase public env not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)",
    );
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    accessToken: async () => (await getAuthToken()) ?? "",
  });
}

/** True once the Auth0 API audience is configured so access tokens are JWTs (T037). */
export function isThirdPartyAuthConfigured(): boolean {
  return Boolean(process.env.AUTH0_AUDIENCE && process.env.AUTH0_AUDIENCE.trim());
}
