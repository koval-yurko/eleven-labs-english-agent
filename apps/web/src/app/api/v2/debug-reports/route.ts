import type { DebugReportResponse } from "@tutor/shared/api";
import { sanitizeDebugReport } from "@tutor/shared/debug/report";

import { withBearer } from "../../../../lib/auth/bearer";
import {
  countRecentDebugReports,
  DEBUG_REPORTS_PER_HOUR,
  insertDebugReport,
} from "../../../../lib/debug-reports";
import { apiError, json, preflight } from "../../../../lib/http";
import { getLesson } from "../../../../lib/lessons";

// Owner-scoped write; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `POST /api/v2/debug-reports` — where a report filed from the phone lands.
 *
 * Same four opening lines as every other v2 write route, and the same auth: `withBearer` has
 * already proven who the caller is, and the owner is stamped from the token rather than the body.
 *
 * Three things here are deliberately NOT what the transcript route does:
 *
 * 1. **An unknown lesson does not 404.** `/api/v2/lessons/session` correctly 404s, because a
 *    transcript for a lesson that does not exist is meaningless. A REPORT whose lesson id is wrong
 *    is evidence about a wrong lesson id — refusing it discards exactly the report that would have
 *    explained the bug. So the lesson is checked, and a failed check nulls the column instead of
 *    rejecting the row.
 * 2. **No `after()` work, no LangSmith trace, no `revalidatePath`.** A report is not an event in
 *    the learner's history; it is an artifact ABOUT one. Nothing downstream is derived from it.
 * 3. **The rate limit answers 200, not 429.** See below.
 *
 * See docs/2026-09-09-mobile-debug-reports-and-feedback.md §10.
 */
export const POST = withBearer(async (req, ownerId) => {
  const input = sanitizeDebugReport(await req.json().catch(() => null));
  // The sanitizer truncates rather than rejects wherever truncation is meaningful, so reaching here
  // means the body was not a report at all — no object, or no recognisable `kind`.
  if (!input) return apiError(400, "bad_request", "Malformed debug report.");

  /**
   * The cap DROPS the report and answers 200.
   *
   * A 429 would be honest and wrong: the spool retries on 5xx and network errors and deletes on any
   * 4xx, so a 429 would either be discarded (losing a report to a limit that has since expired) or,
   * if the spool were ever changed to retry it, retried forever against a limit its own retries are
   * filling. `stored: false` tells the phone the truth and ends the transaction.
   */
  if ((await countRecentDebugReports(ownerId)) >= DEBUG_REPORTS_PER_HOUR) {
    return json({ id: null, stored: false } satisfies DebugReportResponse);
  }

  // Checked against the owner exactly as `persistTutorSessionFor` does — ids from a client are
  // never trusted — but the failure is a nulled column, not a refusal. See (1) above.
  const lesson = input.lessonId ? await getLesson(ownerId, input.lessonId) : null;

  const id = await insertDebugReport(ownerId, input, lesson?.id ?? null);
  return json({ id, stored: true } satisfies DebugReportResponse);
});
