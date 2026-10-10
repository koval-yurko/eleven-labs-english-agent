/**
 * `POST /api/v2/ops/debug-reports/archive-resolved` — archive every resolved report still in the
 * active list, across ALL owners (D10 — see `../route.ts` before changing anything here).
 *
 * Deliberately narrow, as `archiveResolvedDebugReports` explains: `status = 'resolved'` only, never
 * "whatever the current filter shows". Idempotent: a second call archives nothing and says 0.
 */
import type { OpsArchiveResolvedResponse } from "@tutor/shared/api";

import { ALL_OWNERS, archiveResolvedDebugReports } from "@tutor/server/debug-reports";

import { withServerBearer } from "../../../../../lib/auth/bearer";
import { json } from "../../../../../lib/http";

export const POST = withServerBearer(async () => {
  const body: OpsArchiveResolvedResponse = {
    archived: await archiveResolvedDebugReports(ALL_OWNERS),
  };
  return json(body);
});
