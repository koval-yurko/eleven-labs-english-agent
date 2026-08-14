import { revalidatePath } from "next/cache";
import { getOwnerId } from "./auth/session";
import { getLesson, upsertLessonSession } from "./lessons";
import { sanitizeTranscript } from "@tutor/shared/tutor";
import type { TutorSessionInput } from "@tutor/shared/api";

/**
 * Persist the transcript of a tutor conversation — the one code path behind every way a transcript
 * can reach us: the server action (`saveLessonSessionAction`, on a clean `onDisconnect`), the
 * beacon route (`/api/lessons/session`, from `pagehide`/`freeze` when iOS is about to suspend the
 * page and a `fetch` would not survive), and the native route (`/api/v2/lessons/session`). The
 * post-call webhook later upserts the richer copy (summary, duration) onto the same
 * conversation_id row, so all of them converge on one row.
 *
 * Server-only. Ids from a client are never trusted: the owner is established by the caller's auth
 * and the lesson is checked against it. The payload shape itself lives in `packages/shared/src/api.ts` —
 * a client has to construct it, and this module imports `next/cache`, so it could never be the
 * declaration site.
 */

export type { TutorSessionInput };

/**
 * The owner-scoped core. No auth and no cache invalidation — both belong to the caller, because
 * they differ per transport: the cookie paths resolve the owner from a session and want
 * `revalidatePath`, while the Bearer path already has a verified owner and has no rendered page to
 * invalidate (the native client refetches).
 *
 * Split out for `/api/v2/lessons/session`, which cannot call `getOwnerId()` — that reads a cookie
 * the phone does not have. See docs/2026-08-13-expo-s3-conversation-token.md D24.
 *
 * True when the session was stored; false when the lesson is unknown or not this owner's.
 */
export async function persistTutorSessionFor(
  ownerId: string,
  input: TutorSessionInput,
): Promise<boolean> {
  // The lesson must exist AND belong to the caller — never trust ids from a client.
  const lesson = await getLesson(ownerId, input.lessonId);
  if (!lesson || !input.conversationId) return false;

  const transcript = sanitizeTranscript(input.lines);

  await upsertLessonSession({
    lessonId: lesson.id,
    ownerId,
    conversationId: String(input.conversationId).slice(0, 200),
    agentVersion: String(input.agentVersion ?? "").slice(0, 100) || null,
    transcript,
  });
  return true;
}

/**
 * The cookie path (server action + the v1 beacon route): resolve the owner from the Auth0 session,
 * then invalidate the rendered lesson page.
 *
 * True when the session was stored; false when unauthenticated, unknown lesson, or not the owner's.
 */
export async function persistTutorSession(input: TutorSessionInput): Promise<boolean> {
  const ownerId = await getOwnerId();
  if (!ownerId) return false;

  const stored = await persistTutorSessionFor(ownerId, input);
  if (stored) revalidatePath(`/lessons/${input.lessonId}`);
  return stored;
}
