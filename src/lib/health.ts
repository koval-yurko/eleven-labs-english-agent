import { getServiceSupabase, hasSupabaseEnv } from "./supabase/server";
import { elevenLabsConfig } from "./config";
import { activeVersions } from "./agent-registry";
import { hasAnthropicEnv } from "./llm";

/** Result of a single integration health probe. */
export interface Check {
  ok: boolean;
  detail: string;
}

/** Supabase connectivity: read the example owner-scoped table (proves DB + schema). */
export async function checkSupabase(): Promise<Check> {
  if (!hasSupabaseEnv()) {
    return { ok: false, detail: "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" };
  }
  try {
    const { error, count } = await getServiceSupabase()
      .from("health_pings")
      .select("id", { count: "exact", head: true });
    if (error) return { ok: false, detail: error.message };
    return { ok: true, detail: `health_pings reachable (${count ?? 0} rows)` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * ElevenLabs connectivity: probe a ConvAI endpoint the app actually uses (key stays
 * server-side). We avoid /v1/user because restricted keys may lack the `user_read` scope
 * while still having full ConvAI access — probing /convai validates the scope we depend on.
 */
export async function checkElevenLabs(): Promise<Check> {
  const { apiKey } = elevenLabsConfig();
  if (!apiKey) return { ok: false, detail: "ELEVENLABS_API_KEY not set" };
  // Probe the newest active tutor agent if one is provisioned; otherwise list agents (validates
  // the ConvAI scope the app depends on without needing a specific id).
  const active = activeVersions();
  const newest = active[active.length - 1];
  try {
    const url = newest
      ? `https://api.elevenlabs.io/v1/convai/agents/${newest.agentId}`
      : "https://api.elevenlabs.io/v1/convai/agents";
    const res = await fetch(url, { headers: { "xi-api-key": apiKey } });
    if (!res.ok) return { ok: false, detail: `ElevenLabs API returned HTTP ${res.status}` };
    return {
      ok: true,
      detail: newest
        ? `key valid · ${active.length} active version(s) · default ${newest.version}`
        : "key valid · no agents provisioned (run `pnpm sync:agents`)",
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Anthropic/LangChain availability: the key is present (a live call happens via askClaude). */
export function checkAnthropic(): Check {
  return hasAnthropicEnv()
    ? { ok: true, detail: `key set · model ${process.env.ANTHROPIC_MODEL?.trim() || "claude-opus-4-8"}` }
    : { ok: false, detail: "ANTHROPIC_API_KEY not set" };
}
