/**
 * `GET /api/v2/ops/debug-reports` — feedback-tracker's report list.
 *
 * ─── CROSS-OWNER. Read this before touching anything under `routes/v2/ops/`. ─────────────────
 *
 * Every route here reads or writes EVERY learner's debug reports, and any authenticated caller
 * may use them — decision D10, an ACCEPTED RISK written up in
 * docs/2026-10-10-services-split-hono-api.md §6.1. The API audience is shared with the mobile app,
 * so "any authenticated caller" includes every learner, and a report carries a transcript tail,
 * device state and the learner's note. That is accepted only while the operator is the only learner.
 *
 * The trigger to close it is the first learner who is not the operator; the fix is an
 * `OPS_OWNER_IDS` allowlist checked in one wrapper beside `withServerBearer` — no route changes.
 * Every cross-owner query names `ALL_OWNERS` at its call site, so it is visible in review.
 *
 * Server-to-server only (`withServerBearer`: no CORS, no preflight) — feedback-tracker calls this
 * from its own server with the operator's access token.
 */
import type { OpsDebugReportListResponse, OpsDebugReportQuery } from "@tutor/shared/api";
import type { DebugReportKind, DebugReportScope } from "@tutor/shared/debug/report";

import {
  ALL_OWNERS,
  countResolvedActiveDebugReports,
  debugReportFacets,
  listDebugReports,
} from "@tutor/server/debug-reports";

import { withServerBearer } from "../../../../lib/auth/bearer";
import { json } from "../../../../lib/http";

const KINDS: readonly DebugReportKind[] = ["error", "feedback", "manual"];
const SCOPES: readonly DebugReportScope[] = ["active", "archived", "all"];

/** Unknown values are dropped, not rejected — a stale bookmark should show a wider list, not a 400. */
function parseQuery(url: URL): OpsDebugReportQuery {
  const one = (key: string) => url.searchParams.get(key)?.trim() || undefined;
  const since = one("since");
  return {
    kind: KINDS.find((k) => k === one("kind")),
    provider: one("provider"),
    errorCode: one("errorCode"),
    status: one("status"),
    since: since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : undefined,
    scope: SCOPES.find((s) => s === one("scope")) ?? "active",
  };
}

export const GET = withServerBearer(async (req) => {
  const filter = parseQuery(new URL(req.url));
  const [reports, facets, resolvedActive] = await Promise.all([
    listDebugReports(ALL_OWNERS, filter),
    debugReportFacets(ALL_OWNERS, filter.scope),
    countResolvedActiveDebugReports(ALL_OWNERS),
  ]);
  const body: OpsDebugReportListResponse = { reports, facets, resolvedActive };
  return json(body);
});
