import { after } from "next/server";

import type { LessonSessionResponse, TutorSessionInput } from "@tutor/shared/api";
import type { TranscriptLine } from "@tutor/shared/tutor/session";

import { resolveVersion } from "../../../../../lib/agent-registry";
import { withBearer } from "../../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../../lib/http";
import { traceClientLesson } from "../../../../../lib/langsmith-trace";
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

  const agentVersion = typeof body.agentVersion === "string" ? body.agentVersion : "";
  const lines = Array.isArray(body.lines) ? (body.lines as TranscriptLine[]) : [];

  const stored = await persistTutorSessionFor(ownerId, {
    lessonId: body.lessonId,
    conversationId: body.conversationId,
    agentVersion,
    lines,
  });

  // 404, not the beacon route's 401. There, `false` conflated "not signed in" with "not your
  // lesson" and 401 was the honest answer; here `withBearer` has already proven who the caller is,
  // so the only remaining cause is a lesson that is not theirs — and answering 401 would send a
  // correctly-authenticated phone back to a login screen over a mistyped id.
  if (!stored) return apiError(404, "not_found", "No such lesson.");

  /**
   * The observability half, and ONLY for providers that have no post-call webhook.
   *
   * ElevenLabs is deliberately excluded: its webhook already files a richer trace for the same
   * conversation — per-turn usage, tool calls, a platform cost figure — and tracing here as well
   * would give every lesson two records that disagree in detail. OpenAI has no webhook and no
   * post-call transcript endpoint, so this write is the only witness there is
   * (docs/2026-08-22-openai-lesson-observability.md).
   *
   * `after()` so it cannot delay the response, and a swallowed failure because an observability
   * write must never be able to fail a transcript write. The version is resolved rather than
   * trusted: it arrives from a client, and an unknown one traces nothing rather than guessing.
   */
  const resolved = agentVersion ? resolveVersion(agentVersion) : null;
  if (
    resolved &&
    resolved.provider !== "elevenlabs" &&
    lines.length > 0 &&
    process.env.LANGSMITH_API_KEY?.trim()
  ) {
    after(async () => {
      try {
        await traceClientLesson({
          conversationId: body.conversationId as string,
          lessonId: body.lessonId as string,
          agentVersion,
          provider: resolved.provider,
          ownerId,
          lines,
          usage: body.usage,
        });
      } catch {
        // Best effort by design. The transcript is already stored; a missing trace is the smaller
        // loss, and there is nothing useful to tell the phone about it.
      }
    });
  }

  const response: LessonSessionResponse = { ok: true };
  return json(response);
});
