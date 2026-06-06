import { getOwnerId } from "../../../../../lib/auth/session";
import { getLessonService } from "../../../../../lib/container";
import { apiError, json, unauthorized } from "../../../../../lib/http";

/** POST /api/lessons/{id}/retry — re-run a failed generation (T047, FR-016). */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const { id } = await ctx.params;
  const result = await getLessonService().retry(ownerId, id);
  if (!result.ok) {
    return apiError(result.status, result.code, result.message);
  }
  return json(result.lesson, 202);
}
