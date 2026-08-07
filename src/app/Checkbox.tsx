"use client";

import { Checkbox as Base } from "@base-ui/react/checkbox";
import { CheckIcon } from "./icons";

/**
 * A checkbox the page draws, replacing `<input type="checkbox">`.
 *
 * The native one is rendered by the OS: its tick, its size and — because `accent-color` resolves to
 * `auto` — its colour, which is whatever the person set in their system settings. So it differed not
 * just between macOS/Windows/iOS but between two users on the same machine, and it was never going
 * to be `--accent`.
 *
 * Base UI renders a `<span>` plus a hidden `<input>`, so the tick is ours and the form semantics
 * survive. Note the hidden input for anything reading `FormData` or querying
 * `input[type="checkbox"]` — nothing does today, but `LessonItemsView` does use `new FormData(form)`.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name — this checkbox stands alone in a row, with no visible <label> beside it. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <Base.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="checkbox"
    >
      <Base.Indicator className="checkbox-indicator">
        <CheckIcon size={13} />
      </Base.Indicator>
    </Base.Root>
  );
}
