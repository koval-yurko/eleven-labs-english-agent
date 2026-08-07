import { json, apiError, unauthorized } from "../../../../lib/http";
import { persistTutorSession } from "../../../../lib/tutor-session";
import type { TranscriptLine } from "../../../../lib/tutor";

// Owner-scoped write; never cached.
export const dynamic = "force-dynamic";

/**
 * Beacon twin of `saveLessonSessionAction`: saves a live transcript from `pagehide` / `freeze`,
 * where iOS is about to suspend or discard the page and a `fetch` (or a server action) would not
 * survive the trip. `navigator.sendBeacon` carries same-origin cookies, so the session cookie
 * authenticates this exactly like the action — the owner is re-derived server-side either way.
 *
 * Idempotent: the underlying upsert is keyed by conversation_id, so the beacon, the normal
 * `onDisconnect` save and the post-call webhook all converge on one row.
 * See docs/2026-08-07-ios-keep-session-alive-foreground.md.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    lessonId?: unknown;
    conversationId?: unknown;
    agentVersion?: unknown;
    lines?: unknown;
  } | null;

  if (!body || typeof body.lessonId !== "string" || typeof body.conversationId !== "string") {
    return apiError(400, "bad_request", "lessonId and conversationId are required.");
  }

  const stored = await persistTutorSession({
    lessonId: body.lessonId,
    conversationId: body.conversationId,
    agentVersion: typeof body.agentVersion === "string" ? body.agentVersion : "",
    lines: Array.isArray(body.lines) ? (body.lines as TranscriptLine[]) : [],
  });

  // `persistTutorSession` returns false for both "not signed in" and "not your lesson"; the gate in
  // src/proxy.ts already let the request through unauthenticated so this handler could say so.
  if (!stored) return unauthorized();
  return json({ ok: true });
}
