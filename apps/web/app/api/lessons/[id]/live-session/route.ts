import { getOwnerId } from "../../../../../lib/auth/session";
import { getLiveTutorService } from "../../../../../lib/container";
import { apiError, json, unauthorized } from "../../../../../lib/http";

/**
 * POST /api/lessons/{id}/live-session — mint an owner-scoped live-tutor session token
 * + grounding context (T016, US1). Returns 409 when the lesson isn't ready, 503 with a
 * fallback when live tutor is unavailable (FR-017). The xi-api-key never leaves the
 * server; the body carries only a short-lived conversation token.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const { id } = await ctx.params;

  // Optional seed position so the agent's first context reflects the current item.
  let currentPositionSeconds: number | undefined;
  try {
    const body = (await request.json()) as { currentPositionSeconds?: unknown };
    if (typeof body?.currentPositionSeconds === "number" && body.currentPositionSeconds >= 0) {
      currentPositionSeconds = body.currentPositionSeconds;
    }
  } catch {
    // No/invalid body is fine — current item is then just "the introduction".
  }

  const outcome = await getLiveTutorService().startSession(ownerId, id, currentPositionSeconds);
  if (!outcome.ok) return apiError(outcome.status, outcome.code, outcome.message);
  return json(outcome.token);
}
