import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * SERVER-ONLY Supabase client. Uses the service-role key and MUST never be imported
 * by client components (Constitution V — secrets stay server-side). Every repository
 * query filters/stamps `owner_id` explicitly, so ownership is enforced in code; the
 * RLS policies (0003_rls.sql) are defense-in-depth for any token-scoped access path.
 */
let cached: SupabaseClient | null = null;

export function getServiceSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase env not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export const AUDIO_BUCKET = process.env.SUPABASE_AUDIO_BUCKET ?? "lesson-audio";
