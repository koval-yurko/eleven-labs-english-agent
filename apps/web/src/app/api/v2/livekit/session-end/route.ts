import { after } from "next/server";

import type { TurnRecord } from "@tutor/shared/tutor/livekit-wire";
import {
  HIDDEN_KICKOFF_MESSAGES,
  sanitizeTranscript,
  type TranscriptLine,
} from "@tutor/shared/tutor/session";

import { verifyLessonGrant } from "../../../../../lib/auth/lesson-grant";
import { apiError, json, preflight, unauthorized, withCors } from "../../../../../lib/http";
import { traceLiveKitLesson } from "../../../../../lib/langsmith-trace";
import { storeTurnLedger } from "../../../../../lib/livekit-ledger";
import { upsertLessonSession } from "../../../../../lib/lessons";

// A write per lesson on a credential minted per lesson; nothing here is cacheable.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `POST /api/v2/livekit/session-end` — where the LiveKit worker writes back (research doc §5.2).
 *
 * ## One URL, two jobs, chosen by `?partial=1`
 *
 * The worker posts batches of turns WHILE the lesson runs, so a crash loses the last batch instead
 * of the session. Those posts carry `?partial=1` and do one thing: store the turns. The final post
 * carries the transcript and the end reason as well, and only it upserts `lesson_sessions` and
 * files the trace. A partial that never gets its final still leaves the turns behind — which is
 * precisely the case this shape exists for.
 *
 * ## Everything it is allowed to write comes from the grant, not the body
 *
 * `ownerId`, `lessonId` and `conversationId` are claims the token route signed after verifying the
 * learner owned that lesson. The body supplies only content. So a worker cannot write another
 * learner's lesson even if it is confused, compromised or replayed — which is the property the
 * webhooks get by reading ownership off the lesson row ("never from the metadata a client
 * supplied") and this route gets from the signature.
 *
 * ## The transcript goes through the same two stages as every other writer
 *
 * Drop empty turns and hidden kickoff messages, THEN `sanitizeTranscript`. Four writers converge on
 * one `lesson_sessions` row keyed by `conversation_id`, and the stored content must not depend on
 * which one landed last (CLAUDE.md). This is the fifth, and it changes nothing about that rule.
 */
export async function POST(req: Request): Promise<Response> {
  const grant = await verifyLessonGrant(req);
  if (!grant) return withCors(unauthorized());

  const body = (await req.json().catch(() => null)) as {
    turns?: unknown;
    lines?: unknown;
    version?: unknown;
    durationSecs?: unknown;
  } | null;
  if (!body) return apiError(400, "bad_request", "Expected a JSON body.");

  const turns: TurnRecord[] = Array.isArray(body.turns)
    ? (body.turns.filter(
        (t) => typeof t === "object" && t !== null && typeof (t as TurnRecord).seq === "number",
      ) as TurnRecord[])
    : [];

  // Stored FIRST, and on every post. A final post that fails to upsert the session has still
  // banked the turns it carried; the reverse would lose them for a row that already exists.
  await storeTurnLedger({
    conversationId: grant.conversationId,
    ownerId: grant.ownerId,
    turns,
  });

  const partial = new URL(req.url).searchParams.get("partial") === "1";
  if (partial) return json({ ok: true, stored: turns.length });

  const transcript: TranscriptLine[] = sanitizeTranscript(
    (Array.isArray(body.lines) ? body.lines : [])
      .filter(
        (l): l is TranscriptLine =>
          typeof l === "object" &&
          l !== null &&
          typeof (l as TranscriptLine).text === "string" &&
          (l as TranscriptLine).text.length > 0 &&
          !(
            (l as TranscriptLine).role === "user" &&
            HIDDEN_KICKOFF_MESSAGES.includes((l as TranscriptLine).text)
          ),
      ),
  );

  const version = typeof body.version === "string" ? body.version.slice(0, 100) || null : null;
  const durationSecs = typeof body.durationSecs === "number" ? Math.round(body.durationSecs) : null;

  await upsertLessonSession({
    lessonId: grant.lessonId,
    ownerId: grant.ownerId,
    conversationId: grant.conversationId,
    agentVersion: version,
    transcript,
    durationSecs,
  });

  /**
   * The observability half, in `after()` so it cannot delay the worker, and gated before scheduling
   * rather than inside — the same shape `/api/v2/lessons/session` uses.
   *
   * A swallowed failure on purpose: the transcript and the ledger are already stored, a missing
   * trace is the smaller loss, and there is nothing useful to tell a worker about it.
   *
   * The WHOLE ledger is read back rather than tracing the turns this request happened to carry:
   * with partial batching the final post may hold only the last few, and a trace of the last few
   * turns of a lesson would be worse than none.
   */
  if (process.env.LANGSMITH_API_KEY?.trim()) {
    after(async () => {
      try {
        await traceLiveKitLesson({
          conversationId: grant.conversationId,
          lessonId: grant.lessonId,
          ownerId: grant.ownerId,
          version,
          durationSecs,
        });
      } catch {
        // Best effort by design; see above.
      }
    });
  }

  return json({ ok: true, stored: turns.length });
}
