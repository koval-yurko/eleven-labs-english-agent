"use client";

import { Select as Base } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "./icons";

/**
 * The app's single dropdown, replacing native `<select>`.
 *
 * Why not the native element: the OS renders it, so it ignores our `font: inherit`, our field
 * colours and our border radius (on iOS it's a full-screen wheel at the system font size, which is
 * why the app looked like two different designs), and its option list can't be sized or truncated —
 * a long label like a tutor-version name just blew the control out.
 *
 * Base UI's Select is the same control rebuilt as real DOM we own, so the popup obeys this file's
 * CSS. Three of its knobs do the actual work here, and they're deliberate:
 *
 *  - `alignItemWithTrigger={false}` — Base UI defaults to the macOS behaviour of overlapping the
 *    trigger so the selected item sits under the cursor. That needs room above *and* below, which a
 *    filter row near the top of the viewport doesn't have. `false` gives the ordinary "menu drops
 *    below" placement that flips to above only when it must.
 *  - `--available-height` on the popup — the space the positioner actually has to the viewport
 *    edge. Capping `max-height` with it means a long list scrolls inside the popup instead of
 *    running off-screen.
 *  - `--anchor-width` as the popup's `min-width` (not `width`) — the popup is at least as wide as
 *    the trigger, but a label longer than the trigger widens the popup rather than being clipped.
 *
 * Generic over the value so `onValueChange` hands back the caller's union (`SortKey`, …) instead of
 * a bare `string` that every call site would have to cast.
 */
export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  disabled,
  placeholder,
  label,
  id,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  disabled?: boolean;
  placeholder?: string;
  /** Accessible name for the trigger. Required — a bare dropdown tells a screen reader nothing. */
  label: string;
  id?: string;
}) {
  return (
    <Base.Root
      // `items` is what lets <Base.Value> print the *label* for the current value without the
      // popup being mounted (it's in a portal and only exists while open).
      items={options as SelectOption<T>[]}
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      disabled={disabled}
    >
      <Base.Trigger id={id} className="select-trigger" aria-label={label}>
        <Base.Value className="select-value" placeholder={placeholder} />
        <Base.Icon className="select-icon">
          <ChevronDownIcon size={16} />
        </Base.Icon>
      </Base.Trigger>

      <Base.Portal>
        <Base.Positioner className="select-positioner" sideOffset={6} alignItemWithTrigger={false}>
          <Base.Popup className="select-popup">
            <Base.List>
              {options.map((option) => (
                <Base.Item key={option.value} value={option.value} className="select-item">
                  <Base.ItemIndicator className="select-item-indicator">
                    <CheckIcon size={15} />
                  </Base.ItemIndicator>
                  <Base.ItemText className="select-item-text">{option.label}</Base.ItemText>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
