import { getOwnerId } from "../../../../../lib/auth/session";
import { getTranscriptService } from "../../../../../lib/container";
import { json, notFound, unauthorized } from "../../../../../lib/http";

/**
 * GET /api/lessons/{id}/transcript — review the lesson's durable live-story transcript(s)
 * in a later session (T044, US5, FR-024). Owner-scoped; sessions most-recent-first, each
 * with its turns ordered by turnIndex. NO audio is ever returned (FR-025) — the text
 * transcript is the replayable record.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const { id } = await ctx.params;
  const transcript = await getTranscriptService().listTranscript(ownerId, id);
  if (transcript === null) return notFound(); // missing OR not owned — no existence leak

  return json(transcript);
}
