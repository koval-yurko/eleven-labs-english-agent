"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getOwnerId } from "../../lib/auth/session";
import { createLesson, getLesson, upsertLessonSession } from "../../lib/lessons";
import type { TranscriptLine } from "../../lib/tutor";

const MAX_ITEMS = 50;
const MAX_LINES = 500;

/** Create a lesson from the form (title optional — defaults to the first item) and open it. */
export async function createLessonAction(formData: FormData): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId) return;

  const items = String(formData.get("items") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
  const first = items[0];
  if (!first) return;

  const fallback = items.length > 1 ? `${first} +${items.length - 1} more` : first;
  const title = (String(formData.get("title") ?? "").trim() || fallback).slice(0, 120);

  const id = await createLesson(ownerId, title, items);
  revalidatePath("/");
  redirect(`/lessons/${id}`);
}

/**
 * Save the transcript of a just-finished tutor conversation, from the browser. The post-call
 * webhook later upserts the richer copy (summary, duration) onto the same conversation_id row,
 * so history shows up immediately even if the webhook is delayed or lost.
 */
export async function saveLessonSessionAction(input: {
  lessonId: string;
  conversationId: string;
  agentVersion: string;
  lines: TranscriptLine[];
}): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId) return;

  // The lesson must exist AND belong to the caller — never trust ids from the browser.
  const lesson = await getLesson(ownerId, input.lessonId);
  if (!lesson || !input.conversationId) return;

  const transcript = input.lines
    .slice(0, MAX_LINES)
    .filter((l) => (l.role === "user" || l.role === "agent") && typeof l.text === "string")
    .map((l) => ({ role: l.role, text: l.text.slice(0, 4000) }));

  await upsertLessonSession({
    lessonId: lesson.id,
    ownerId,
    conversationId: String(input.conversationId).slice(0, 200),
    agentVersion: String(input.agentVersion ?? "").slice(0, 100) || null,
    transcript,
  });
  revalidatePath(`/lessons/${lesson.id}`);
}
