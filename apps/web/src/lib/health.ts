import { getServiceSupabase, hasSupabaseEnv } from "./supabase/server";
import { elevenLabsConfig } from "./config";
import { activeVersions, resolveAgent } from "./agent-registry";
import { hasAnthropicEnv } from "./llm";
import type { HealthCheck, HealthStatus } from "@tutor/shared/api";

/** Result of a single integration health probe — the shape `/api/health` serves. */
export type Check = HealthCheck;

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

  /**
   * Which agent to probe — and the reason this is no longer "the newest active version".
   *
   * It used to be `activeVersions()[length - 1]`, which was right while ElevenLabs was the only
   * provider and became a permanent 503 the moment it was not. The newest active version is now
   * `words-3.0`, a VAPI version whose `agentId` is a Vapi assistant uuid, and this asked
   * `api.elevenlabs.io` about it. A real 404 about a real id, reported as an ElevenLabs outage.
   *
   * Three tiers, most meaningful first:
   *
   *   1. **The default version's agent** (`resolveAgent()` with no argument). This is the one a
   *      learner who never opens the picker is taught by, so it is the one whose reachability is
   *      worth asserting. `resolveAgent` returns null unless the resolved version is ElevenLabs AND
   *      has a provisioned id, which is exactly the guard that was missing.
   *   2. **The newest ElevenLabs version**, when the default runs somewhere else. Still a real agent
   *      probe, still validates the ConvAI scope.
   *   3. **The agent list**, when no ElevenLabs version is active at all. That is a legitimate state
   *      now that other providers exist — not a failure — so it reports `ok` and says so.
   */
  const active = activeVersions();
  const onElevenLabs = active.filter(
    (v): v is (typeof active)[number] & { agentId: string } =>
      v.provider === "elevenlabs" && v.agentId !== null,
  );
  const target = resolveAgent() ?? onElevenLabs[onElevenLabs.length - 1] ?? null;

  try {
    const url = target
      ? `https://api.elevenlabs.io/v1/convai/agents/${target.agentId}`
      : "https://api.elevenlabs.io/v1/convai/agents";
    const res = await fetch(url, { headers: { "xi-api-key": apiKey } });
    // WHAT was probed, not just that something returned 404. The failure this replaces said only
    // "ElevenLabs API returned HTTP 404" — true, and it named neither the id nor the version, so it
    // read as a dead key rather than as a probe pointed at the wrong provider.
    if (!res.ok) {
      return {
        ok: false,
        detail: `ElevenLabs API returned HTTP ${res.status} probing ${target ? `${target.version} (${target.agentId})` : "the agent list"}`,
      };
    }
    return {
      ok: true,
      detail: target
        ? `key valid · ${target.version} reachable · ${onElevenLabs.length}/${active.length} active version(s) on ElevenLabs`
        : `key valid · no ElevenLabs version is active (${active.length} active on other providers)`,
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

// ── the probe ────────────────────────────────────────────────────────────────────────────────

/**
 * How long a third-party probe result is reused.
 *
 * `checkElevenLabs` makes a real network call to `api.elevenlabs.io` with our key, and an uptime
 * monitor polls on a schedule someone else chooses. Without a cache a misconfigured monitor at one
 * request per second turns our own health endpoint into 86,400 daily calls against that key — a
 * rate limit we would then diagnose as an ElevenLabs outage, caused by the thing watching for one.
 *
 * So the guarantee is about the CEILING rather than the freshness: at most two ElevenLabs calls a
 * minute no matter how hard this is polled. The cost is up to 30s of staleness, which is inside the
 * detection window any sane monitor already allows.
 *
 * Module scope, so it lives as long as the warm instance and a cold start simply re-probes.
 */
const PROBE_CACHE_MS = 30_000;

let cached: { at: number; check: Check } | null = null;

/** `checkElevenLabs`, with the third-party call bounded. See `PROBE_CACHE_MS`. */
export async function checkElevenLabsCached(now: number = Date.now()): Promise<Check> {
  if (cached && now - cached.at < PROBE_CACHE_MS) return cached.check;
  const check = await checkElevenLabs();
  cached = { at: now, check };
  return check;
}

/**
 * Which dependencies a LEARNER's request actually needs, and therefore which ones are worth a 503.
 *
 * - **Supabase — critical.** Every route reads or writes it. Down means nothing works.
 * - **ElevenLabs — critical**, and this is the judgement call. Other providers exist and a learner
 *   who opens the picker could start a lesson on OpenAI or Vapi — but `DEFAULT_PROMPT_VERSION` is
 *   `words-1.0`, an ElevenLabs version, so a learner who never opens it cannot start at all. If the
 *   default ever moves to another provider, this classification should move with it.
 * - **Anthropic — NOT critical.** It is reached only by `levels.ts` and `word-details.ts`, both of
 *   which run as `after()` on the write path and as sweep scripts. Their columns are nullable
 *   forever and the jobs have no deadline, so an outage delays a backfill and no lesson notices.
 *
 * `auth` is absent on purpose: it describes the caller, not the service.
 */
export function healthStatus(checks: {
  supabase: Check;
  elevenlabs: Check;
  anthropic: Check;
}): HealthStatus {
  if (!checks.supabase.ok || !checks.elevenlabs.ok) return "down";
  return checks.anthropic.ok ? "ok" : "degraded";
}
