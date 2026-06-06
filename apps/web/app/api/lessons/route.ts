import type { NextRequest } from "next/server";
import { CreateLessonRequest } from "@idiomatic/contracts";
import { getOwnerId } from "../../../lib/auth/session";
import { getLessonService } from "../../../lib/container";
import { apiError, json, unauthorized } from "../../../lib/http";

/** POST /api/lessons — submit a list & start generation (T028/T045). */
export async function POST(request: NextRequest) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_body", "Request body must be valid JSON.");
  }

  const parsed = CreateLessonRequest.safeParse(body);
  if (!parsed.success) {
    return apiError(400, "invalid_body", "Expected { items: string[] | string }.");
  }

  const outcome = await getLessonService().createLesson(ownerId, parsed.data.items);
  if (!outcome.ok) {
    return json(
      {
        error: { code: outcome.code, message: outcome.message },
        ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
        ...(outcome.limit !== undefined
          ? { limit: outcome.limit, received: outcome.received }
          : {}),
      },
      outcome.status,
    );
  }

  return json(outcome.lesson, 202);
}

/** GET /api/lessons — list the caller's lessons, newest first (T039/FR-020). */
export async function GET() {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();
  const lessons = await getLessonService().listLessons(ownerId);
  return json({ lessons });
}
