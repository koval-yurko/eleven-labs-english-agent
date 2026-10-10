"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The app's button.
 *
 * Two problems it exists to fix, both measured in Chrome against the old bare `<button>`:
 *
 *  1. **The UA gives buttons their own font.** `globals.css` set `font: inherit` on `input` and
 *     `textarea` but never on `button`, so every button in the app rendered in **Arial at
 *     13.3px** while its neighbouring field rendered in system-ui at 16px. That default differs by
 *     OS and engine — the same class of problem as the old `<select>`, hiding in plain sight.
 *  2. **Buttons were 34.7px tall next to 45.2px fields.** The "Add" button only *looked* aligned
 *     because the global `margin-top: 0.6rem` happened to push a too-short button into roughly the
 *     right place.
 *
 * The fix is not a magic height: `.btn` reproduces the field's vertical box exactly — 1.5 line
 * height, the same 0.6rem padding, the same 1px border (transparent when the variant has no
 * visible one) — so the two agree at any font size. `--control-height` pins the same figure for
 * content shorter than a line of text, i.e. icon-only buttons.
 *
 * Variants are about shape, `tone` only about colour, which keeps "a destructive icon button" and
 * "a destructive solid button" from needing separate variants.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "icon" | "inline";

export function Button({
  variant = "primary",
  size = "md",
  tone,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /**
   * - `primary` — accent fill, the default action
   * - `secondary` — bordered, same box, for a neutral action beside a primary one
   * - `quiet` — no fill or border, still a full-size control
   * - `icon` — square, chrome-free; needs an `aria-label`
   * - `inline` — no box at all, for a button sitting inside a sentence
   */
  variant?: ButtonVariant;
  /**
   * `md` (default) matches the height of an input, for anything standing beside a field.
   * `sm` is the compact tier the Select trigger uses — for controls among navigation or chips,
   * where a field-sized button would dominate. Ignored by `icon` and `inline`, which size
   * themselves.
   */
  size?: "md" | "sm";
  /** `danger` recolours whichever variant is in use; it never changes the shape. */
  tone?: "danger";
  children: ReactNode;
}) {
  const classes = [
    "btn",
    `btn--${variant}`,
    size === "sm" ? "btn--sm" : null,
    tone ? `btn--${tone}` : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  // `type` defaults to "submit" inside a form, which has bitten this codebase's non-submit buttons
  // before — every call site had to remember `type="button"`. Default it the safe way instead.
  return (
    <button type="button" {...props} className={classes}>
      {children}
    </button>
  );
}
