import { getOwnerId } from "../../../../../lib/auth/session";
import { getStartStoryService } from "../../../../../lib/container";
import { apiError, json, unauthorized } from "../../../../../lib/http";

/**
 * POST /api/lessons/{id}/live-story — start an adaptive live-narration session (T023, US1).
 * Derives the lesson plan, mints an owner-scoped conversation token, opens a `LiveSession`
 * row, and returns the per-session grounding (`StartStoryToken`). 409 when the lesson isn't
 * ready; 503 with a fallback body when live story is unavailable (FR-026, R7). The
 * xi-api-key never leaves the server; the body carries only a short-lived conversation token.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const { id } = await ctx.params;

  const outcome = await getStartStoryService().startStory(ownerId, id);
  if (!outcome.ok) return apiError(outcome.status, outcome.code, outcome.message);
  // The documented `StartStoryToken` is the credential subset; the derived `plan` is the
  // grounding the browser's narration state machine needs (coverage by id, beats). It is
  // not secret and is reproducible from the lesson script.
  return json({ ...outcome.token, plan: outcome.plan });
}
