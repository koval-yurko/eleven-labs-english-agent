"use client";

import { useState, useTransition } from "react";

import { Button } from "../../Button";
import { ConfirmDialog } from "../../ConfirmDialog";
import { deleteReportAction } from "./actions";

/**
 * Delete, behind a confirmation — the one control on the operator pages that needs JavaScript.
 *
 * A delete is the only write here that cannot be taken back (Resolve has Reopen), so it gets the
 * app's `ConfirmDialog` rather than a bare form button a stray click could fire. One dialog per
 * button rather than one per list: a hundred-row page mounts a hundred closed dialogs, which is
 * nothing, and it keeps the list page a server component with no "which row is pending" state.
 */
export function DeleteReportButton({
  id,
  label,
  returnToList = false,
  size = "sm",
}: {
  id: string;
  /** What the report is, as the dialog names it — the error code, or the kind. */
  label: string;
  /** On the detail page: go back to the list once the row is gone. */
  returnToList?: boolean;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        tone="danger"
        size={size}
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        {pending ? "Deleting…" : "Delete"}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete this ${label} report?`}
        description="It is removed for good. If it was a real problem that is now fixed, resolve it instead so the fix stays findable."
        confirmLabel="Delete"
        onConfirm={() => startTransition(() => deleteReportAction(id, returnToList))}
      />
    </>
  );
}
