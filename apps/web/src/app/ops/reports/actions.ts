"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getOwnerId } from "../../../lib/auth/session";
import {
  RESOLVED_STATUS,
  deleteDebugReport,
  setDebugReportTriage,
} from "../../../lib/debug-reports";

/**
 * The operator page's writes: triage (status + resolution), the one-click Resolve / Reopen, and
 * Delete.
 *
 * `FormData` rather than a typed argument wherever the caller is a plain `<form action={…}>` with
 * no client component behind it: the pages stay server components, and triage costs one round trip
 * and no JavaScript. That is the same trade the filters on the list page make. Delete is the
 * exception — it sits behind a confirmation dialog, which needs a client component anyway.
 *
 * Like every action here each one re-derives the owner from the session and never trusts the
 * payload; the id is passed through to a query that is owner-scoped in its own `where`, so a forged
 * id updates nothing rather than someone else's row.
 */
export async function triageReportAction(form: FormData): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId) return;

  const id = String(form.get("id") ?? "");
  if (!id) return;

  const status = String(form.get("status") ?? "new").trim() || "new";
  const resolution = String(form.get("resolution") ?? "").trim();

  await setDebugReportTriage(ownerId, id, { status, resolution: resolution || null });
  revalidateReport(id);
}

/**
 * Mark a report resolved. From the list it is a bare button and only the status changes; from the
 * detail page it submits the triage form, so a resolution typed there is saved with it.
 */
export async function resolveReportAction(form: FormData): Promise<void> {
  await setStatus(form, RESOLVED_STATUS);
}

/** Undo a Resolve — back to `new`, the state a report arrives in. */
export async function reopenReportAction(form: FormData): Promise<void> {
  await setStatus(form, "new");
}

async function setStatus(form: FormData, status: string): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId) return;

  const id = String(form.get("id") ?? "");
  if (!id) return;

  // Absent field → leave the stored resolution alone; present-but-empty → clear it, same as Save.
  const raw = form.get("resolution");
  const resolution = raw === null ? undefined : String(raw).trim() || null;

  await setDebugReportTriage(ownerId, id, { status, resolution });
  revalidateReport(id);
}

/**
 * Delete a report. `returnToList` is for the detail page, which would otherwise re-render as a 404
 * for the row it just removed; the list page stays where it is, filters and all.
 */
export async function deleteReportAction(id: string, returnToList: boolean): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId || !id) return;

  await deleteDebugReport(ownerId, id);
  revalidatePath("/ops/reports");
  if (returnToList) redirect("/ops/reports");
}

/**
 * Both paths, and both are needed: the detail page shows the new values, and the list shows the new
 * status in its first column — which is what the "group by what is still open" read depends on.
 */
function revalidateReport(id: string): void {
  revalidatePath(`/ops/reports/${id}`);
  revalidatePath("/ops/reports");
}
