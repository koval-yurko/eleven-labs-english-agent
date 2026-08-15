import { parseOutboxRecords, type FlushResult } from "@tutor/shared/sync-ops";

import { withBearer } from "../../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../../lib/http";
import { applyOps, scheduleWordJobs } from "../../../../../lib/sync-flush";

// Owner-scoped write; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `POST /api/v2/sync/flush` — every lesson and item mutation the native app makes.
 *
 * One route rather than four bespoke REST mutations, and it stays that way even though v1 is
 * online-only (creation doc §3.3). The app sends **single-op batches** through the op algebra that
 * already exists and is already checked, so adding offline later is a purely client-side change:
 * queue the ops in SQLite instead of posting them immediately, and this handler never learns the
 * difference.
 *
 * It calls `applyOps`, NOT the `flushOutbox` Server Action. That action opens with `getOwnerId()`,
 * which is cookie-only permanently by the design that keeps the Bearer path from ever running for
 * the web app — calling it here would return `{ applied: [] }` for every request, silently.
 * See docs/2026-08-13-expo-s5-lessons.md D45.
 *
 * No `revalidatePath`: that is the web caller's Next-cache concern and the native client refetches
 * (creation doc §3.2). Both web lesson pages are `force-dynamic` anyway.
 */
export const POST = withBearer(async (req, ownerId) => {
  // Shape validation at the edge. `applyOp`'s switch is exhaustive over `OutboxOp` and has no
  // `default`, so at runtime an unknown `kind` matches nothing, does not throw, and would be
  // reported as APPLIED — a lie to an arbitrary caller on a public route (D46).
  const records = parseOutboxRecords(await req.json().catch(() => null));
  if (!records) return apiError(400, "bad_request", "Malformed outbox batch.");

  const { applied, addedItems } = await applyOps(ownerId, records);

  // The level + enrichment fast paths, shared with the Server Action rather than copied. Without
  // them a word added from the phone has no CEFR level and no `details` until the next sweep, and
  // nothing about that is visible at the time (creation doc §3.2).
  if (addedItems) scheduleWordJobs(ownerId);

  // `applied` is "you may stop retrying these records", not "they had an effect" — see `applyOps`.
  // The client reconciles by re-reading, which is why this shape needs nothing added to it (D47).
  const body: FlushResult = { applied };
  return json(body);
});
