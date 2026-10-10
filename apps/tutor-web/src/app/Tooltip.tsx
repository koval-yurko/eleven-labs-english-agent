"use client";

import type { ReactElement } from "react";
import { Tooltip as Base } from "@base-ui/react/tooltip";

/**
 * A hover/focus hint, replacing the `title=""` attribute.
 *
 * What this fixes is the OS chrome: `title` is drawn by the browser, at a delay you can't set, in a
 * style that has nothing to do with the app.
 *
 * What it does NOT fix is touch — Base UI disables tooltips on touch devices, exactly as `title`
 * is unusable there. That's correct behaviour, not a gap: a tooltip is for a trigger whose purpose
 * is something *else* (this one deletes a lesson), and its content must therefore be redundant.
 * The trash button carries its real name in `aria-label`; this only spells it out for a mouse.
 *
 * When the content is NOT redundant — when a touch user would lose information by never seeing it —
 * it isn't a tooltip. See `InfoPopover`, which is the tappable counterpart.
 */
export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Base.Root>
      {/* `render` hands the trigger's behaviour to the caller's own element rather than wrapping it
          in another button — the trash icon is already a button. */}
      <Base.Trigger render={children} />
      <Base.Portal>
        <Base.Positioner sideOffset={6} side="top">
          <Base.Popup className="tooltip-popup">{label}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
