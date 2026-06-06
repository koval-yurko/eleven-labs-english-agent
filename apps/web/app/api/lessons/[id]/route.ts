import { getOwnerId } from "../../../../lib/auth/session";
import { getLessonService } from "../../../../lib/container";
import { json, notFound, unauthorized } from "../../../../lib/http";

/** GET /api/lessons/{id} — owner-scoped status + detail (T029, FR-015). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const { id } = await ctx.params;
  const detail = await getLessonService().getLesson(ownerId, id);
  if (!detail) return notFound(); // missing OR not owned — no existence leak (SC-005)

  return json(detail);
}
