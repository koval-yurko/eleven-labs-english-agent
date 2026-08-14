import type { LessonSessionResponse, TutorSessionInput } from "@tutor/shared/api";
import type { TranscriptLine } from "@tutor/shared/tutor";

import { withBearer } from "../../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../../lib/http";
import { persistTutorSessionFor } from "../../../../../lib/tutor-session";

// Owner-scoped write; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `POST /api/v2/lessons/session` — the native twin of the beacon route, and the third thin caller
 * of the same `lib/` function (creation doc §3.2). Same request body, same upsert, same
 * `sanitizeTranscript` bounds — the only difference is where the owner comes from.
 *
 * Idempotent: the underlying upsert is keyed by conversation_id, so this write, the browser's and
 * the post-call webhook's all converge on one row. That convergence is exactly what S3's gate
 * measures, and it only holds because the client sends the id the token route gave it rather than
 * the one the WebRTC transport derived.
 */
export const POST = withBearer(async (req, ownerId) => {
  const body = (await req.json().catch(() => null)) as Partial<TutorSessionInput> | null;

  if (!body || typeof body.lessonId !== "string" || typeof body.conversationId !== "string") {
    return apiError(400, "bad_request", "lessonId and conversationId are required.");
  }

  const stored = await persistTutorSessionFor(ownerId, {
    lessonId: body.lessonId,
    conversationId: body.conversationId,
    agentVersion: typeof body.agentVersion === "string" ? body.agentVersion : "",
    lines: Array.isArray(body.lines) ? (body.lines as TranscriptLine[]) : [],
  });

  // 404, not the beacon route's 401. There, `false` conflated "not signed in" with "not your
  // lesson" and 401 was the honest answer; here `withBearer` has already proven who the caller is,
  // so the only remaining cause is a lesson that is not theirs — and answering 401 would send a
  // correctly-authenticated phone back to a login screen over a mistyped id.
  if (!stored) return apiError(404, "not_found", "No such lesson.");

  const response: LessonSessionResponse = { ok: true };
  return json(response);
});
