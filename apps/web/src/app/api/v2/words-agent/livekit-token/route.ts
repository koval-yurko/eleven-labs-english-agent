import { randomUUID } from "node:crypto";

import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";

import type { LiveKitTokenResponse, RealtimeTokenRequest } from "@tutor/shared/api";
import { formatItemsList, type TutorItem } from "@tutor/shared/tutor/session";
import {
  LIVEKIT_AGENT_NAME,
  type LiveKitDispatchMetadata,
} from "@tutor/shared/tutor/livekit-wire";

import { effectiveConfig, findVersion } from "../../../../../agent/prompts";
import { resolveVersion } from "../../../../../lib/agent-registry";
import { withBearer } from "../../../../../lib/auth/bearer";
import { signLessonGrant } from "../../../../../lib/auth/lesson-grant";
import { apiError, json, preflight } from "../../../../../lib/http";
import { getLesson } from "../../../../../lib/lessons";

// Mints a credential per request; nothing here is cacheable.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `POST /api/v2/words-agent/livekit-token` — the LiveKit twin of the ElevenLabs, OpenAI and Vapi
 * token routes (research doc §1, task plan Phase 3).
 *
 * ## The lesson travels in the token, not in the response
 *
 * The three older providers each hand the client something the client must pass on: an agent id, an
 * instructions blob, a rendered item list. LiveKit does not. The prompt, the items, the turn plan
 * and the write-back grant go into `RoomConfiguration.agents[].metadata` — **dispatch metadata** —
 * which is a claim inside the JWT below and is delivered by LiveKit to the worker when it assigns
 * the job. The phone carries it without reading it.
 *
 * That makes this the only provider where a shipped binary cannot alter the lesson even by
 * accident: there is no field for it to set. What the phone *can* do is base64-decode its own token
 * and read the metadata (JWTs are signed, not encrypted — §3.10). That was checked and accepted:
 * the metadata holds this lesson's own prompt and items, which the learner is about to hear anyway,
 * and never a credential. `LIVEKIT_API_SECRET` signs the token and never enters it.
 *
 * ## Why the agent is dispatched by name
 *
 * `agentName` turns OFF LiveKit's automatic dispatch, so a room gets a tutor only when a token asks
 * for one by name. Without it every room the project ever creates would summon a worker. The name
 * is `LIVEKIT_AGENT_NAME` from the wire contract, not a string typed here, because the worker's
 * `ServerOptions.agentName` must match it byte-for-byte or the job is never assigned — a failure
 * that looks like a tutor who simply never speaks.
 *
 * ## Which versions this route serves
 *
 * Only versions whose `provider` is `"livekit"` — today `words-4.0`. The same refusal the sibling
 * routes make, for the same reason (§11.1): these prompts were written for a particular pipeline,
 * and running one on another is a different lesson, not a fallback.
 */
export const POST = withBearer(async (req, ownerId) => {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) {
    return apiError(500, "config", "LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set.");
  }

  let body: RealtimeTokenRequest;
  try {
    body = (await req.json()) as RealtimeTokenRequest;
  } catch {
    return apiError(400, "bad_request", "Expected a JSON body.");
  }
  if (typeof body?.lessonId !== "string" || body.lessonId.length === 0) {
    return apiError(400, "bad_request", "lessonId is required.");
  }
  const items: TutorItem[] = Array.isArray(body.items) ? body.items : [];

  const requested = body.version;
  const resolved = resolveVersion(requested);
  if (!resolved) {
    return apiError(
      requested ? 400 : 500,
      "config",
      requested ? `Unknown or inactive tutor version "${requested}".` : "No active tutor versions.",
    );
  }
  if (resolved.provider !== "livekit") {
    return apiError(
      400,
      "wrong_provider",
      `Tutor version "${resolved.version}" runs on ${resolved.provider}, not LiveKit.`,
    );
  }
  const chosen = findVersion(resolved.version);
  if (!chosen) return apiError(500, "config", `Version "${resolved.version}" vanished mid-request.`);
  const config = effectiveConfig(chosen);

  /**
   * The ownership check the OTHER providers make at write time, made here instead.
   *
   * On every other provider the phone reports the transcript, so `persistTutorSessionFor` can call
   * `getLesson(ownerId, lessonId)` and refuse a lesson that isn't the caller's. Here the WORKER
   * writes, holding a grant and no session — so if this id were never checked, the only check would
   * be gone. Doing it at mint also means `lessonId` can be signed into the grant, which is how the
   * session-end route fills a NOT NULL `lesson_sessions.lesson_id` without trusting its caller.
   */
  const lesson = await getLesson(ownerId, body.lessonId);
  if (!lesson) return apiError(404, "not_found", "No such lesson.");

  const conversationId = randomUUID();

  /**
   * Minted BEFORE the room token, and the lesson is refused if it cannot be.
   *
   * A lesson that starts without a grant is one whose transcript, ledger and saved words all fail
   * at the end, after the learner has spent twenty minutes on it. Failing here costs a retry;
   * failing there costs the session.
   */
  const grant = await signLessonGrant({ conversationId, ownerId, lessonId: lesson.id });
  if (!grant) {
    return apiError(500, "config", "LIVEKIT_GRANT_SECRET is not set; the lesson could not be authorized.");
  }

  const metadata: LiveKitDispatchMetadata = {
    conversationId,
    version: chosen.version,
    // The dynamic-variable substitution ElevenLabs does at runtime, done here — the same line the
    // OpenAI route runs, and for the same reason: the prompt never leaves this process.
    instructions: config.prompt.replaceAll("{{items_list}}", formatItemsList(items)),
    llm: chosen.llm,
    grant,
  };

  /**
   * The room is named after the conversation, not the lesson. A learner who starts the same lesson
   * twice gets two rooms, so the second attempt cannot inherit a room whose previous tutor is still
   * leaving it — and the room name is a key the debug report can be read against later.
   */
  const roomName = `lesson-${conversationId}`;

  const at = new AccessToken(apiKey, apiSecret, {
    // The learner's own id, so the worker sees who it is talking to without being told twice.
    identity: ownerId,
    // Long enough for a lesson and the pauses in it; the grant outlives it on purpose, since the
    // session-end write lands after the learner has gone.
    ttl: "1h",
  });
  at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: LIVEKIT_AGENT_NAME,
        metadata: JSON.stringify(metadata),
      }),
    ],
  });

  const payload: LiveKitTokenResponse = {
    url,
    token: await at.toJwt(),
    roomName,
    conversationId,
    version: chosen.version,
  };
  return json(payload);
});
