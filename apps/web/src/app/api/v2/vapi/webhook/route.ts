import { timingSafeEqual } from "node:crypto";

import { HIDDEN_KICKOFF_MESSAGES, sanitizeTranscript } from "@tutor/shared/tutor/session";
import type { TranscriptLine } from "@tutor/shared/tutor/session";

import { vapiConfig } from "../../../../../lib/config";
import { apiError, json } from "../../../../../lib/http";
import { getLessonById, upsertLessonSession } from "../../../../../lib/lessons";
import { hasSupabaseEnv } from "../../../../../lib/supabase/server";

// Reads a secret and compares a header; never cacheable.
export const dynamic = "force-dynamic";

/**
 * `POST /api/v2/vapi/webhook` — Vapi's post-call report.
 *
 * The direct counterpart of `api/words-agent/elevenlabs-webhook`, and the thing §11.5 of the OpenAI
 * note listed as a LOSS when that provider arrived: OpenAI has no post-call delivery at all, so a
 * lesson's stored transcript depends entirely on the client surviving to write it. Vapi gives it
 * back — one delivery carrying `endedReason`, the committed messages, the duration and the cost.
 *
 * ## Authentication
 *
 * Deliberately PUBLIC, like the ElevenLabs one: a webhook carries no session. The shared secret IS
 * the authentication. `pnpm sync:agents` provisions it onto the assistant (`server.secret`), Vapi
 * echoes it in `x-vapi-secret`, and this route refuses anything that does not match — including,
 * loudly, every request when the secret is unset. An unauthenticated writer to `lesson_sessions`
 * would be worse than no writer.
 *
 * ## Where the lesson id comes from
 *
 * `assistantOverrides.metadata`, stamped by the mobile adapter at `start()`. Vapi echoes it back on
 * the call object. Ownership is NOT taken from there — the metadata comes from a client and is
 * never trusted for that — it is read off the lesson row, exactly as the ElevenLabs webhook does.
 *
 * The conversation id is ours too, minted by the token route, so this writer lands on the SAME
 * `lesson_sessions` row the client wrote at session end rather than creating a second one. Vapi's
 * own call id is deliberately not the key: it does not exist yet when the row is first written.
 */
export async function POST(req: Request) {
  // The same reader `sync:agents` uses to PROVISION `server.secret`, so the value verified here and
  // the value Vapi was given cannot drift apart. Unset means this route can authenticate nothing,
  // and a webhook that skips authentication is an open writer to `lesson_sessions`.
  const { webhookSecret } = vapiConfig();
  if (!webhookSecret) return apiError(500, "config", "VAPI_WEBHOOK_SECRET is not set.");

  const presented = req.headers.get("x-vapi-secret") ?? "";
  if (!secretMatches(presented, webhookSecret)) {
    return apiError(401, "bad_secret", "Missing or invalid x-vapi-secret.");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "bad_request", "Expected a JSON body.");
  }

  const message = (body as { message?: Record<string, unknown> })?.message;
  // Ack anything else rather than erroring. A 4xx makes Vapi retry, and retrying a message we were
  // never going to act on is a storm with no upside.
  if (!message || message.type !== "end-of-call-report") {
    return json({ ok: true, ignored: (message?.type as string) ?? "unknown" });
  }

  try {
    const persisted = await persistLessonSession(message);
    return json({ ok: true, persisted });
  } catch (e) {
    // A failure here is OURS. Log it and ack, so Vapi does not retry-storm a bug on our side.
    console.error("[vapi-webhook] failed to persist session:", e);
    return json({ ok: false, persisted: false });
  }
}

/** Constant-time compare that cannot throw on a length mismatch. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on differing lengths, which would itself leak length — compare a
  // fixed-size digest-shaped pair instead by checking length first and returning the same way.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** One turn as Vapi commits it. Fields read defensively; nothing off the wire is trusted. */
interface VapiArtifactMessage {
  role?: string;
  message?: string;
  secondsFromStart?: number;
}

/**
 * Attach the finished call to its lesson's history.
 *
 * Mirrors `persistLessonSession` in the ElevenLabs webhook step for step, including the two-stage
 * filter — drop empty turns and every hidden kickoff, THEN `sanitizeTranscript` — because these two
 * writers and the client all converge on one row and the stored content must not depend on which
 * one landed last. That is the rule `sanitizeTranscript` exists to enforce (CLAUDE.md).
 */
async function persistLessonSession(message: Record<string, unknown>): Promise<boolean> {
  if (!hasSupabaseEnv()) return false;

  const call = message.call as Record<string, unknown> | undefined;
  const overrides = call?.assistantOverrides as Record<string, unknown> | undefined;
  const metadata = overrides?.metadata as Record<string, unknown> | undefined;
  const lessonId = typeof metadata?.lessonId === "string" ? metadata.lessonId : null;
  const conversationId =
    typeof metadata?.conversationId === "string" ? metadata.conversationId : null;
  const version = typeof metadata?.version === "string" ? metadata.version : null;
  // Without both ids there is no row to write and no way to find one. Ack and skip — a call started
  // outside the app (a dashboard test, say) is a normal thing to receive here, not an error.
  if (!lessonId || !conversationId) return false;

  const lesson = await getLessonById(lessonId);
  if (!lesson) return false;

  const artifact = message.artifact as Record<string, unknown> | undefined;
  const raw = Array.isArray(artifact?.messages) ? (artifact.messages as VapiArtifactMessage[]) : [];

  const transcript: TranscriptLine[] = sanitizeTranscript(
    raw
      .filter(
        (m) =>
          typeof m?.message === "string" &&
          m.message.length > 0 &&
          // Vapi's own vocabulary: `bot` is the tutor, `user` the learner. Anything else — `system`,
          // and the synthetic `tool_calls` entries — is not a spoken turn and must not be stored as
          // one.
          (m.role === "bot" || m.role === "user") &&
          // The whole ARRAY, never one constant. Every hidden message the client sends must be
          // filtered here, or the kickoff lands in the learner's history as something they said.
          !(m.role === "user" && HIDDEN_KICKOFF_MESSAGES.includes(m.message)),
      )
      .map((m) => ({
        role: m.role === "bot" ? ("agent" as const) : ("user" as const),
        text: m.message as string,
        ...(typeof m.secondsFromStart === "number"
          ? { timeInCallSecs: Math.round(m.secondsFromStart) }
          : {}),
      })),
  );

  const durationSecs =
    typeof call?.startedAt === "string" && typeof call?.endedAt === "string"
      ? Math.max(
          0,
          Math.round(
            (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000,
          ),
        )
      : null;

  await upsertLessonSession({
    lessonId: lesson.id,
    // From the LESSON row, never from the metadata a client supplied.
    ownerId: lesson.owner_id,
    conversationId,
    agentVersion: version,
    transcript,
    // Vapi's analysis plan can produce one, but nothing configures it today — recorded as absent
    // rather than invented, so a summary appearing later means the plan was turned on.
    summary: typeof artifact?.summary === "string" ? artifact.summary : null,
    durationSecs,
  });
  return true;
}
