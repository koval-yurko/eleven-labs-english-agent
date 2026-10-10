"use client";

import { Popover } from "@base-ui/react/popover";

/**
 * A tappable "what does this mean?" hint.
 *
 * The touch-capable sibling of `Tooltip`, and the reason both exist. Base UI draws the line this
 * way: if the trigger's purpose is to open the popup, it's a popover; if the trigger does something
 * else and the popup is a redundant hint, it's a tooltip. Tooltips — native `title` and Base UI's
 * alike — are disabled on touch.
 *
 * This app is used on an iPhone (see the foreground-session docs), so a hint that only exists on
 * hover is a hint most of its users will never see. `openOnHover` keeps the mouse behaviour of the
 * `title` it replaced; the button is what makes it reachable by tap.
 */
export function InfoPopover({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger openOnHover className="info-trigger" aria-label={label}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} side="top">
          <Popover.Popup className="info-popup">{label}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
