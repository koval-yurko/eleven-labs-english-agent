"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";

/**
 * A yes/no confirmation for an action that can't be undone.
 *
 * `AlertDialog`, not `Dialog`: it renders `role="alertdialog"`, and it deliberately can't be
 * dismissed by clicking the backdrop — a destructive action should need an actual answer, not a
 * stray click. Escape and Cancel both still back out.
 *
 * It stays as non-blocking as the inline confirmation it replaced (this is React state, not
 * `window.confirm`, which would freeze the event loop and stall the optimistic offline write the
 * delete path depends on). What it adds over inline is a focus trap, Escape, a labelled
 * `role="alertdialog"` a screen reader announces, and focus returning to the button that opened it.
 *
 * Controlled on purpose: the one caller drives it from "which row is pending", so a single dialog
 * serves the whole list instead of one mounted per row.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after the close animation finishes — where to drop the state the prompt was describing,
   *  so its text doesn't blank out mid-fade. */
  onOpenChangeComplete?: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" />
        <AlertDialog.Viewport className="dialog-viewport">
          <AlertDialog.Popup className="dialog-popup">
            <AlertDialog.Title className="dialog-title">{title}</AlertDialog.Title>
            {description ? (
              <AlertDialog.Description className="dialog-description">
                {description}
              </AlertDialog.Description>
            ) : null}
            <div className="dialog-actions">
              {/* Cancel first in the DOM so it takes initial focus — the safe default for a
                  destructive prompt, and it puts the recovery action one Tab from the dangerous
                  one rather than the other way round. */}
              {/* The dialog's buttons are the app's buttons — Cancel reads as the quiet option so
                  the destructive one isn't the only thing the eye lands on. */}
              <AlertDialog.Close className="btn btn--secondary">{cancelLabel}</AlertDialog.Close>
              <AlertDialog.Close className="btn btn--primary btn--danger" onClick={onConfirm}>
                {confirmLabel}
              </AlertDialog.Close>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
