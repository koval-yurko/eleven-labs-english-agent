"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  API_V2_ROUTES,
  opsDebugReportPath,
  type OpsArchiveResolvedResponse,
  type OpsDebugReportDeleteResponse,
  type OpsDebugReportPatch,
  type OpsDebugReportPatchResponse,
} from "@tutor/shared/api";
import { RESOLVED_STATUS } from "@tutor/shared/debug/report";

import { apiFetch } from "../../lib/api";
import { getOwnerId } from "../../lib/auth/session";

/**
 * The operator's writes: triage (status + resolution), the one-click Resolve / Reopen,
 * Archive / Unarchive, and Delete — each one call to `/api/v2/ops/debug-reports`.
 *
 * `FormData` rather than a typed argument wherever the caller is a plain `<form action={…}>` with
 * no client component behind it: the pages stay server components, and triage costs one round trip
 * and no JavaScript. Delete is the exception — it sits behind a confirmation dialog, which needs a
 * client component anyway.
 *
 * Cross-owner (D10 — docs/2026-10-10-services-split-hono-api.md §6.1): the API lets any signed-in
 * caller triage any learner's report. The session check here only keeps a signed-out form post
 * from reaching the API at all.
 */

async function patch(id: string, body: OpsDebugReportPatch): Promise<void> {
  await apiFetch<OpsDebugReportPatchResponse>(opsDebugReportPath(id), { method: "PATCH", json: body });
  revalidateReport(id);
}

function formId(form: FormData): string | null {
  const id = String(form.get("id") ?? "");
  return id || null;
}

export async function triageReportAction(form: FormData): Promise<void> {
  const id = formId(form);
  if (!(await getOwnerId()) || !id) return;

  const status = String(form.get("status") ?? "new").trim() || "new";
  const resolution = String(form.get("resolution") ?? "").trim();
  await patch(id, { status, resolution: resolution || null });
}

export async function resolveReportAction(form: FormData): Promise<void> {
  await setStatus(form, RESOLVED_STATUS);
}

export async function reopenReportAction(form: FormData): Promise<void> {
  await setStatus(form, "new");
}

async function setStatus(form: FormData, status: string): Promise<void> {
  const id = formId(form);
  if (!(await getOwnerId()) || !id) return;

  // Absent field → leave the stored resolution alone; present-but-empty → clear it, same as Save.
  const raw = form.get("resolution");
  const resolution = raw === null ? undefined : String(raw).trim() || null;
  await patch(id, resolution === undefined ? { status } : { status, resolution });
}

export async function archiveReportAction(form: FormData): Promise<void> {
  await setArchived(form, true);
}

export async function unarchiveReportAction(form: FormData): Promise<void> {
  await setArchived(form, false);
}

async function setArchived(form: FormData, archived: boolean): Promise<void> {
  const id = formId(form);
  if (!(await getOwnerId()) || !id) return;
  await patch(id, { archived });
}

export async function archiveResolvedAction(): Promise<void> {
  if (!(await getOwnerId())) return;

  await apiFetch<OpsArchiveResolvedResponse>(`${API_V2_ROUTES.opsDebugReports}/archive-resolved`, {
    method: "POST",
  });
  revalidatePath("/reports");
}

export async function deleteReportAction(id: string, returnToList: boolean): Promise<void> {
  if (!(await getOwnerId()) || !id) return;

  await apiFetch<OpsDebugReportDeleteResponse>(opsDebugReportPath(id), { method: "DELETE" });
  revalidatePath("/reports");
  if (returnToList) redirect("/reports");
}

function revalidateReport(id: string): void {
  revalidatePath(`/reports/${id}`);
  revalidatePath("/reports");
}
