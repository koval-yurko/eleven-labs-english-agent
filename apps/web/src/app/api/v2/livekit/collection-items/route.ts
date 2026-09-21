import { MAX_WORD_LENGTH } from "@tutor/shared/words/key";
import { MAX_ITEMS } from "@tutor/shared/offline/ops";

import { verifyLessonGrant } from "../../../../../lib/auth/lesson-grant";
import { apiError, json, preflight, unauthorized, withCors } from "../../../../../lib/http";
import { scheduleWordJobs } from "../../../../../lib/sync-flush";
import { addWords } from "../../../../../lib/words";

// A write, per lesson, on a credential minted per lesson; nothing here is cacheable.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `POST /api/v2/livekit/collection-items` — what the LiveKit tutor's `add_words_to_collection` tool
 * actually calls.
 *
 * **Why this exists instead of the worker calling `/api/mcp`.** MCP is the seam that lets a HOSTED
 * agent — ElevenLabs, OpenAI, Vapi — call into this backend, because none of them can run our code.
 * The LiveKit worker is our code, and its Claude adapter owns the `tools` array it sends to
 * Anthropic, so it has no need of that seam. Teaching `/api/mcp` to accept a second credential
 * format would have meant restoring the whole owner chain `docs/2026-08-27-mcp-static-token-auth.md`
 * §2 deleted, and breaking its §8.3 rule — "No second way in. One header, one scheme" — in the
 * commit that restored it. See docs/2026-09-25-lesson-grant-tool-authorization.md.
 *
 * **The whole point is the owner.** `/api/mcp` authenticates a caller, not a person, so it stamps
 * `owner_id = NULL` and the word lands in the pool every learner reads. This route knows who the
 * learner is, because the grant was minted from an Auth0 `sub` the token route had just verified.
 * Below the auth line it is the same call the mobile app's own add makes.
 *
 * It writes `words` and attaches nothing to a lesson — deliberate parity with the MCP tool, which
 * creates no `lesson_items` row either. Changing that is a product decision, not this route's.
 */
export async function POST(req: Request): Promise<Response> {
  const grant = await verifyLessonGrant(req);
  if (!grant) return withCors(unauthorized());

  const body = (await req.json().catch(() => null)) as { words?: unknown } | null;
  if (!Array.isArray(body?.words)) {
    return apiError(400, "bad_request", "words must be an array of strings.");
  }

  /**
   * The tool's own limits, imported rather than retyped: the same `MAX_ITEMS` and `MAX_WORD_LENGTH`
   * the MCP schema enforces (`lib/mcp/add-words.ts`). A model that asks for a thousand words is
   * refused here rather than trusted — learner speech is untrusted input to a model that holds a
   * write tool (research doc §3.10), and the grant bounds WHOSE collection, not how much.
   */
  const words = body.words;
  if (words.length === 0 || words.length > MAX_ITEMS) {
    return apiError(400, "bad_request", `words must hold 1 to ${MAX_ITEMS} entries.`);
  }
  if (!words.every((w) => typeof w === "string" && w.length > 0 && w.length <= MAX_WORD_LENGTH)) {
    return apiError(400, "bad_request", `each word must be 1 to ${MAX_WORD_LENGTH} characters.`);
  }

  const result = await addWords(grant.ownerId, words as string[]);

  // The same rule as every other write path: without this the word has no CEFR level and no
  // `details` until the next sweep, and nothing about that is visible at the time.
  if (result.added.length > 0) scheduleWordJobs(grant.ownerId);

  // The MCP tool's own output shape, so the prompt clause that reads it needs no rewrite for this
  // provider (`agent/prompts/save-to-collection.ts`).
  return json({
    added: result.added,
    already_present: result.alreadyPresent,
    skipped: result.skipped,
  });
}
