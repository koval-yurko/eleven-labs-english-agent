import { getSweepService } from "../../../../lib/container";
import { liveStoryTracingConfig } from "../../../../lib/config";
import { apiError, json } from "../../../../lib/http";

/**
 * POST /api/live-story/sweep — scheduled abandonment finalizer (008-langsmith-tracing, US2).
 * Invoked on a cron (see vercel.json). NOT Auth0-authenticated — there is no learner session;
 * it operates across owners with the service-role repo, guarded by a shared `CRON_SECRET`
 * bearer. Force-closes active sessions idle past the threshold and records a finalized
 * `abandoned` trace per session, so disconnected sessions never freeze `active` (FR-003).
 *
 * When `CRON_SECRET` is unset the route is effectively disabled (every call is 401), keeping a
 * public ingress closed until deliberately configured.
 *
 * Both GET and POST are accepted: Vercel Cron issues GET (and injects `Authorization: Bearer
 * $CRON_SECRET` automatically), while manual/other schedulers can POST.
 */
async function runSweep(request: Request): Promise<Response> {
  const cfg = liveStoryTracingConfig();
  const expected = cfg.sweepSecret ? `Bearer ${cfg.sweepSecret}` : null;
  const provided = request.headers.get("authorization");
  if (!expected || provided !== expected) {
    return apiError(401, "unauthorized", "Invalid sweep credentials.");
  }

  const result = await getSweepService().sweep({
    now: new Date(),
    idleMinutes: cfg.sweepIdleMinutes,
    limit: cfg.sweepBatchLimit,
  });
  return json(result, 200);
}

export const GET = runSweep;
export const POST = runSweep;
