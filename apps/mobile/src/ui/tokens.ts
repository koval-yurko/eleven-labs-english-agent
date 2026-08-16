/**
 * The geometry half of the design system — the web's `globals.css`, resolved to numbers.
 *
 * Colours are NOT here: they come from `@tutor/shared/theme` via `useTheme()`, because that is the
 * part that drifted and the part both apps must agree on byte for byte. Geometry stays per-platform
 * on purpose. The web declares it in `rem` "so both track the root font size rather than pinning
 * pixels the fields wouldn't follow" (`globals.css`), and flattening that into this file would cost
 * the web its font-size accessibility to buy the phone nothing. So: the same *design*, expressed in
 * each platform's own unit, with every value below carrying the rem it came from.
 *
 * A screen that needs a number it cannot find here is a screen about to invent a thirteenth grey's
 * cousin. Add it here instead.
 *
 * See docs/2026-08-15-web-design-parity-on-mobile.md §1.2, §7.
 */

/** Resolved against the web's 16px root. Kept as a named constant so the arithmetic below reads. */
const REM = 16;

export const layout = {
  /**
   * `main { max-width: 760px }`. Invisible on a phone and the whole point on an iPad — without it
   * a 1024pt-wide screen renders a lesson title across eleven inches of line length.
   */
  contentWidth: 760,
  /** `main`'s padding: 2rem top / 1.25rem sides / 4rem bottom, before safe-area insets. */
  pagePaddingTop: 2 * REM, // 32
  pagePaddingHorizontal: 1.25 * REM, // 20
  pagePaddingBottom: 4 * REM, // 64
  /** `header { margin-bottom: 1.5rem }`. */
  headerGap: 1.5 * REM, // 24
} as const;

export const control = {
  /**
   * The height contract. `--control-height` is 24px of line box + 2 × 0.6rem padding + 2 × 1px
   * border — i.e. exactly what the web's `input`/`textarea` rules already compute to, which is why
   * a button and the field beside it line up at any font size. Reproduce the BOX, never the number:
   * `Button` and `TextField` below both build it from `paddingVertical` + `borderWidth`, and this
   * constant is the floor (`minHeight`) for content shorter than a line.
   */
  height: 2.825 * REM, // 45.2
  /** `--control-height-sm` — header furniture, chips, the Select trigger. */
  heightSm: 2.25 * REM, // 36
  /** `.btn` padding: 0.6rem 1.1rem. */
  paddingVertical: 0.6 * REM, // 9.6
  paddingHorizontal: 1.1 * REM, // 17.6
  /** `.btn--sm` padding: 0.4rem 0.75rem — also the Select trigger's. */
  paddingVerticalSm: 0.4 * REM, // 6.4
  paddingHorizontalSm: 0.75 * REM, // 12
  /** `input` padding: 0.6rem 0.75rem. */
  fieldPaddingVertical: 0.6 * REM, // 9.6
  fieldPaddingHorizontal: 0.75 * REM, // 12
  /**
   * Extra room under the last line of a MULTILINE field, so `g`, `p` and `j` keep their tails.
   *
   * A `lineHeight` on a `TextInput` is not the harmless declaration it is on a `Text`: iOS turns it
   * into the paragraph style's minimum/maximum line height, and TextKit spends the whole difference
   * between it and the font's natural line box ABOVE the baseline. The glyphs therefore sit that
   * much lower inside their line than the box suggests, and the descenders of the last line land on
   * — or a hair past — the bottom of the text container, which clips them. Clipped at the bottom
   * with the ascenders untouched is the signature of exactly this and of nothing else.
   *
   * `TextField` answers it twice, because the two cases have different right answers: a single-line
   * field has no line spacing to express, so it simply drops `lineHeight`; a textarea does, so it
   * keeps it and buys the room back here.
   *
   * The system font's natural line box is ~1.23em (ascent 0.95 + descent 0.28), so the leading spent
   * above the baseline is `lineHeight − 1.23 × fontSize` — 1.5rem − 1.23rem for the body scale.
   * Rounded up: a spare pixel under a textarea is invisible, a pixel short is the bug. (The 1.5 is
   * `type.body`'s ratio, restated rather than read because `type` is declared below this.)
   */
  fieldDescenderSlack: Math.ceil(1.5 * REM - 1.23 * REM), // 5
  /**
   * `.btn--icon`: square, chrome-free, and deliberately NOT `height`. Both icon buttons in the app
   * (the favourite star, the delete bin) sit in dense list rows next to a 20px checkbox, where a
   * 45px square would inflate every row.
   */
  iconSize: 2 * REM, // 32
  /** `.checkbox` — 1.25rem square. */
  checkboxSize: 1.25 * REM, // 20
} as const;

export const radius = {
  /** `.panel`, `.dialog-popup` */
  panel: 12,
  /** `.select-popup` */
  popup: 10,
  /** `input`, `textarea`, `.btn`, `.select-trigger`, `pre` */
  control: 8,
  /** `.select-item` */
  item: 6,
  /** `.checkbox` */
  checkbox: 5,
  /** `.chip` */
  pill: 999,
} as const;

export const space = {
  /** `.panel { padding: 1.25rem }` */
  panelPadding: 1.25 * REM, // 20
  /** `.panel { margin: 0.75rem 0 }` */
  panelGap: 0.75 * REM, // 12
  /** The recurring `gap: 0.5rem` of the web's flex rows. */
  row: 0.5 * REM, // 8
  /** `.filter-row { gap: 0.35rem }` */
  chipGap: 0.35 * REM, // 5.6
  /** The `gap: 1rem` between the header's nav items. */
  navGap: REM, // 16
} as const;

/**
 * The type scale.
 *
 * `h1` and `h2` are the browser's own defaults (2em and 1.5em of a 16px root, bold) — the web never
 * styles them, so this is the first time those numbers have been written down anywhere. Pinning
 * them is the point: RN has no UA stylesheet to inherit from, and the mobile screens had drifted to
 * a 17/16/15/13 scale that shares no size with the web at all.
 *
 * `lineHeight` follows `body { line-height: 1.5 }` except on the headings, where 1.5 of 32px is
 * loose enough to read as a gap.
 */
export const type = {
  h1: { fontSize: 2 * REM, lineHeight: 2 * REM * 1.2, fontWeight: "700" }, // 32 / 38.4
  h2: { fontSize: 1.5 * REM, lineHeight: 1.5 * REM * 1.25, fontWeight: "700" }, // 24 / 30
  /** `body` — the default for everything unmarked. */
  body: { fontSize: REM, lineHeight: REM * 1.5 }, // 16 / 24
  /** The web's `0.9rem` — `.muted` copy, chips, field descriptions. */
  small: { fontSize: 0.9 * REM, lineHeight: 0.9 * REM * 1.5 }, // 14.4 / 21.6
  /** The web's `0.85rem` — timestamps, tooltips, the tertiary tier. */
  tiny: { fontSize: 0.85 * REM, lineHeight: 0.85 * REM * 1.5 }, // 13.6 / 20.4
  /** `.btn { font-weight: 600 }`, `h1`/`h2` are 700, `.chip` is 500. */
  weightMedium: "500",
  weightSemibold: "600",
  weightBold: "700",
} as const;

/** `.nav-progress { height: 3px; z-index: 100 }` */
export const progress = { height: 3, sweepMs: 1100, finishMs: 260 } as const;

/**
 * `.dialog-popup { width: min(26rem, 100%) }` and `.select-popup { max-width: min(…, 92vw) }`.
 * Both are caps, applied with `maxWidth` against a full-width parent.
 */
export const overlay = {
  dialogWidth: 26 * REM, // 416
  scrim: "rgba(0,0,0,0.5)", // .dialog-backdrop
} as const;
