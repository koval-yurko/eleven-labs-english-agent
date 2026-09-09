"use server";

import { revalidatePath } from "next/cache";

import { getOwnerId } from "../../../lib/auth/session";
import { setDebugReportTriage } from "../../../lib/debug-reports";

/**
 * Mark a report triaged — the only write the operator page makes.
 *
 * `FormData` rather than a typed argument, because the caller is a plain `<form action={…}>` with
 * no client component behind it: the whole detail page stays a server component, and triage costs
 * one round trip and no JavaScript. That is the same trade the filters on the list page make.
 *
 * Like every action here it re-derives the owner from the session and never trusts the payload; the
 * id is passed through to a query that is owner-scoped in its own `where`, so a forged id updates
 * nothing rather than someone else's row.
 */
export async function triageReportAction(form: FormData): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId) return;

  const id = String(form.get("id") ?? "");
  if (!id) return;

  const status = String(form.get("status") ?? "new").trim() || "new";
  const resolution = String(form.get("resolution") ?? "").trim();

  await setDebugReportTriage(ownerId, id, { status, resolution: resolution || null });
  // Both, and both are needed: the detail page shows the new values, and the list shows the new
  // status in its first column — which is what the "group by what is still open" read depends on.
  revalidatePath(`/ops/reports/${id}`);
  revalidatePath("/ops/reports");
}
