import { revalidatePath } from "next/cache";
import { getOwnerId } from "./auth/session";
import { getLesson, upsertLessonSession } from "./lessons";
import type { TranscriptLine } from "./tutor";

/**
 * Persist the transcript of a tutor conversation — the one code path behind both ways the browser
 * can send it: the server action (`saveLessonSessionAction`, used on a clean `onDisconnect`) and the
 * beacon route (`/api/lessons/session`, used from `pagehide`/`freeze` when iOS is about to suspend
 * the page and a `fetch` would not survive). The post-call webhook later upserts the richer copy
 * (summary, duration) onto the same conversation_id row, so all three converge on one row.
 *
 * Server-only. Owner is re-derived from the session; ids from the browser are never trusted.
 */

const MAX_LINES = 500;
const MAX_LINE_CHARS = 4000;

export interface TutorSessionInput {
  lessonId: string;
  conversationId: string;
  agentVersion: string;
  lines: TranscriptLine[];
}

/** True when the session was stored; false when unauthenticated, unknown lesson, or not the owner's. */
export async function persistTutorSession(input: TutorSessionInput): Promise<boolean> {
  const ownerId = await getOwnerId();
  if (!ownerId) return false;

  // The lesson must exist AND belong to the caller — never trust ids from the browser.
  const lesson = await getLesson(ownerId, input.lessonId);
  if (!lesson || !input.conversationId) return false;

  const transcript = (Array.isArray(input.lines) ? input.lines : [])
    .slice(0, MAX_LINES)
    .filter((l) => (l.role === "user" || l.role === "agent") && typeof l.text === "string")
    .map((l) => ({ role: l.role, text: l.text.slice(0, MAX_LINE_CHARS) }));

  await upsertLessonSession({
    lessonId: lesson.id,
    ownerId,
    conversationId: String(input.conversationId).slice(0, 200),
    agentVersion: String(input.agentVersion ?? "").slice(0, 100) || null,
    transcript,
  });
  revalidatePath(`/lessons/${lesson.id}`);
  return true;
}
