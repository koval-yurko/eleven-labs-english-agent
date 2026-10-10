/**
 * `/api/v2/ops/debug-reports/:id` — one report: read it, triage/archive it, or delete it.
 * Cross-owner (D10 — see `../route.ts` before changing anything here).
 *
 *   GET     the report plus everything the detail view shows, resolved server-side: the stored
 *           transcript, LangSmith / provider-console links, the prompt version, the provider's
 *           verdicts and the state diagnosis — so feedback-tracker renders without server code.
 *   PATCH   `{ status?, resolution?, archived? }` — triage and archive in one call.
 *   DELETE  remove it outright (for reports that are wrong, not solved — prefer archive).
 */
import type {
  OpsDebugReportDeleteResponse,
  OpsDebugReportDetailResponse,
  OpsDebugReportPatch,
  OpsDebugReportPatchResponse,
} from "@tutor/shared/api";

import {
  changedFields,
  diagnoseSnapshot,
  orderedFields,
} from "@tutor/server/debug-report-diagnose";
import {
  langsmithTraceName,
  langsmithTraceUrl,
  providerConsoleUrl,
  resolveReportAgent,
} from "@tutor/server/debug-report-links";
import {
  isQuotaVerdict,
  reportVerdicts,
  verdictErrorLabel,
} from "@tutor/server/debug-report-verdict";
import {
  ALL_OWNERS,
  deleteDebugReport,
  getDebugReport,
  getSessionForConversation,
  setDebugReportArchived,
  setDebugReportTriage,
} from "@tutor/server/debug-reports";

import { withServerBearer } from "../../../../../lib/auth/bearer";
import { apiError, json } from "../../../../../lib/http";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => apiError(404, "not_found", "No such report.");

export const GET = withServerBearer<Ctx>(async (_req, _ownerId, { params }) => {
  const { id } = await params;
  const report = await getDebugReport(ALL_OWNERS, id);
  if (!report) return notFound();

  const conversationId = report.conversation_id;
  const [session, langsmith, verdicts] = await Promise.all([
    // The transcript is joined on the REPORT's owner — the one cross-owner read stays the report
    // itself; everything hanging off it is still read as that learner's.
    conversationId ? getSessionForConversation(report.owner_id, conversationId) : null,
    conversationId ? langsmithTraceUrl(conversationId) : null,
    reportVerdicts(report),
  ]);

  const live = report.state?.live;
  const atError = report.state?.atError ?? null;
  const subject = atError ?? live;

  const body: OpsDebugReportDetailResponse = {
    report,
    session,
    links: {
      langsmith,
      langsmithTraceName: conversationId ? langsmithTraceName(conversationId) : null,
      console: conversationId ? providerConsoleUrl(report.provider, conversationId) : null,
    },
    agent: resolveReportAgent(report.agent_version),
    verdicts: verdicts.map((v) => ({
      ...v,
      errorLabel: verdictErrorLabel(v),
      isQuota: isQuotaVerdict(v),
    })),
    diagnosis: {
      liveFields: live ? orderedFields(live) : [],
      atErrorFields: atError ? orderedFields(atError) : [],
      changed: changedFields(live, atError),
      suspicious: subject ? diagnoseSnapshot(subject, report.events ?? []) : [],
    },
  };
  return json(body);
});

/** Absent `resolution` leaves it alone; `null` or blank clears it — the operator form's rule. */
export const PATCH = withServerBearer<Ctx>(async (req, _ownerId, { params }) => {
  const { id } = await params;
  const patch = (await req.json().catch(() => null)) as OpsDebugReportPatch | null;
  if (!patch || typeof patch !== "object") {
    return apiError(400, "bad_request", "Expected a JSON object.");
  }
  if (patch.status === undefined && patch.resolution === undefined && patch.archived === undefined) {
    return apiError(400, "bad_request", "Nothing to change: send status, resolution or archived.");
  }
  if (patch.status !== undefined && typeof patch.status !== "string") {
    return apiError(400, "bad_request", "`status` must be a string.");
  }
  if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
    return apiError(400, "bad_request", "`archived` must be a boolean.");
  }
  if (
    patch.resolution !== undefined &&
    patch.resolution !== null &&
    typeof patch.resolution !== "string"
  ) {
    return apiError(400, "bad_request", "`resolution` must be a string or null.");
  }

  const existing = await getDebugReport(ALL_OWNERS, id);
  if (!existing) return notFound();

  if (patch.status !== undefined || patch.resolution !== undefined) {
    const resolution =
      patch.resolution === undefined ? undefined : patch.resolution?.trim() || null;
    await setDebugReportTriage(ALL_OWNERS, id, {
      status: patch.status?.trim() || existing.status,
      resolution,
    });
  }
  if (patch.archived !== undefined) await setDebugReportArchived(ALL_OWNERS, id, patch.archived);

  const body: OpsDebugReportPatchResponse = { ok: true };
  return json(body);
});

export const DELETE = withServerBearer<Ctx>(async (_req, _ownerId, { params }) => {
  const { id } = await params;
  const body: OpsDebugReportDeleteResponse = { deleted: await deleteDebugReport(ALL_OWNERS, id) };
  return json(body);
});
