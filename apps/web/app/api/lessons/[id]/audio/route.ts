import { NextResponse } from "next/server";
import { getOwnerId } from "../../../../../lib/auth/session";
import { getLessonService } from "../../../../../lib/container";
import { apiError, unauthorized } from "../../../../../lib/http";

/** GET /api/lessons/{id}/audio — redirect to a short-lived signed URL (T030, FR-014). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const { id } = await ctx.params;
  const url = await getLessonService().getAudioUrl(ownerId, id);
  if (!url) {
    // Not owned, missing, or not yet ready.
    return apiError(404, "audio_unavailable", "Audio is not available for this lesson.");
  }
  return NextResponse.redirect(url);
}
