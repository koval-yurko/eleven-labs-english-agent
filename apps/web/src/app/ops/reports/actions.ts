"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getOwnerId } from "../../../lib/auth/session";
import {
  RESOLVED_STATUS,
  archiveResolvedDebugReports,
  deleteDebugReport,
  setDebugReportArchived,
  setDebugReportTriage,
} from "../../../lib/debug-reports";

/**
 * The operator page's writes: triage (status + resolution), the one-click Resolve / Reopen,
 * Archive / Unarchive, and Delete.
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
 * Archive one report — out of the list, still in the table.
 *
 * It does NOT submit alongside triage. On the detail page this is its own small form under the
 * triage one rather than a `formAction` on it, because the two say different things: `formAction`
 * would carry whatever is typed in the Status box at that moment, so archiving would silently
 * save a half-edited triage. Separate forms, separate effects.
 */
export async function archiveReportAction(form: FormData): Promise<void> {
  await setArchived(form, true);
}

/** Undo an Archive — back into the list, with status and resolution untouched. */
export async function unarchiveReportAction(form: FormData): Promise<void> {
  await setArchived(form, false);
}

async function setArchived(form: FormData, archived: boolean): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId) return;

  const id = String(form.get("id") ?? "");
  if (!id) return;

  await setDebugReportArchived(ownerId, id, archived);
  revalidateReport(id);
}

/**
 * Archive every resolved report at once — the list page's one bulk control.
 *
 * Takes no id and reads nothing from the form: what it archives is defined by the query in
 * `archiveResolvedDebugReports`, not by the filters the page happens to be showing. See that
 * function for why.
 */
export async function archiveResolvedAction(): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId) return;

  await archiveResolvedDebugReports(ownerId);
  revalidatePath("/ops/reports");
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
