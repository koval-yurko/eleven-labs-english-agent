import { getBearerOwnerId } from "@tutor/server/auth/bearer";
import {
  checkAnthropic,
  checkElevenLabsCached,
  checkSupabase,
  healthStatus,
} from "@tutor/server/health";
import type { HealthCheck, HealthResponse } from "@tutor/shared/api";

/**
 * `GET /api/health` — the uptime probe.
 *
 * ## What changed, and why it was not one before
 *
 * `allOk` used to include `auth.ok`, which is `Boolean(getOwnerId())` — a COOKIE check. A monitor
 * has no cookie, so every unauthenticated request answered 503 by construction, whatever the
 * service was doing. An endpoint that is permanently red cannot be watched: point a monitor at it
 * and you get paged forever, or you mute it and learn nothing.
 *
 * `auth` is still reported, because it is useful to a human checking a token. It simply does not
 * decide anything. On `services/api` it reads the BEARER token, if one was sent — the API holds no
 * cookie session (docs/2026-10-10-services-split-hono-api.md D12) — so the field keeps its contract
 * (`HealthResponse.auth`) and its meaning ("who is calling, if anyone").
 *
 * ## Three rules a probe has to keep
 *
 * 1. **Never cached.** A 200 served from an edge cache during an outage is the worst possible
 *    failure: the monitor is green and the service is down. Hence `force-dynamic`, `revalidate = 0`
 *    and an explicit `cache-control: no-store` — one of them would probably do, and a probe is not
 *    where to find out which.
 * 2. **Never throws.** The token check reaches Auth0's JWKS and could fail when Auth0 env is
 *    missing or its endpoint is unreachable. Unwrapped, that is a 500 with no body — the probe crashing on exactly
 *    the class of failure it exists to report. It is caught and reported as a check.
 * 3. **`degraded` is a 200.** Anthropic is reached only by background jobs whose columns are
 *    nullable forever; a lesson does not touch it. Paging for that trains people to ignore pages.
 *    See `healthStatus` for which dependency is which and why.
 */
export async function GET(req: Request) {
  const [supabase, elevenlabs, auth] = await Promise.all([
    checkSupabase(),
    // Cached for 30s, so the ceiling on third-party calls is a property of this endpoint rather
    // than of whatever schedule a monitor happens to use. See `PROBE_CACHE_MS`.
    checkElevenLabsCached(),
    checkAuth(req),
  ]);
  const anthropic = checkAnthropic();

  const status = healthStatus({ supabase, elevenlabs, anthropic });
  const body: HealthResponse = { status, auth, supabase, elevenlabs, anthropic };

  return Response.json(body, {
    // Only `down` is worth a 503 — see rule 3 above.
    status: status === "down" ? 503 : 200,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}

/** Who is calling, if anyone. Reported, never decisive — and it must not be able to throw. */
async function checkAuth(req: Request): Promise<HealthCheck> {
  try {
    const ownerId = await getBearerOwnerId(req);
    return {
      ok: Boolean(ownerId),
      detail: ownerId ? `signed in as ${ownerId}` : "no valid bearer token (expected for a monitor)",
    };
  } catch (e) {
    return { ok: false, detail: `token check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
