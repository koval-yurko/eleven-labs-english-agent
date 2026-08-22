/**
 * The colour tokens — one table, both clients.
 *
 * This module exists because the two apps drifted. The LIGHT palettes were byte-identical (the
 * mobile one was copied from the web's `[data-theme="light"]` block and says so); the DARK ones
 * differed on **every single value** — `#0f1115` vs `#101014`, `#7c9cff` vs `#7FB2FF`, and so on
 * down the list. Neither difference was decided; both were transcription noise that nobody could
 * see because the two apps are never on screen together.
 *
 * The web's values win, because the web app is the design of record.
 *
 * **Why this qualifies for the pure core, when a palette arguably shouldn't.** CLAUDE.md's test is
 * "could I fix this bug by deploying the web app alone?" — and a wrong hex on iOS ships through
 * TestFlight, so by the letter of that rule this is a client concern. What earns it a place here is
 * the rule's *purpose*: one protocol, one implementation. This module is inert data — no behaviour,
 * no I/O, no npm dependency, no platform assumption — in exactly the category `CEFR_LEVELS` is
 * already in. It is the drift it prevents, not the logic it holds, that justifies it.
 *
 * **Colours only.** Geometry (control heights, radii, the type scale) deliberately stays
 * per-platform: the web expresses it in `rem` so it tracks the root font size, and flattening that
 * to px here would cost the web its font-size accessibility to buy the phone nothing. The mobile
 * side pins the resolved px in `apps/mobile/src/ui/tokens.ts`, cross-referenced to the rem it came
 * from.
 *
 * See docs/2026-08-15-web-design-parity-on-mobile.md §7.
 */

/**
 * The twelve roles. Every colour either has a role here or does not exist — a screen that reaches
 * for a thirteenth grey is the failure mode this table is for.
 */
export type Palette = {
  /** The page behind everything. */
  bg: string;
  /** Raised fill: the `.panel` card, popups, dialogs. */
  panel: string;
  /** Sunken fill: text inputs, `<pre>`, the sunken half of a control. */
  sunken: string;
  /** Hairline: card outlines, list-row separators, field borders. */
  border: string;
  /** Body text. */
  text: string;
  /** Secondary text: counts, dates, hints, helper copy. */
  muted: string;
  /**
   * Tertiary text: placeholders, timestamps, an inactive star, a list row's preview line.
   *
   * The one role with no pre-existing web counterpart — the web reaches the same tier by rendering
   * `.muted` at `0.85rem`, which works in a document and not in a `StyleSheet`. Values are the
   * mobile app's, which were chosen against these backgrounds and pass AA at 13pt.
   */
  faint: string;
  /** Links, focus rings, filled primary controls, the tutor's voice in a transcript. */
  accent: string;
  /** Text and glyphs drawn ON `accent` — the checkbox tick, a primary button's label. */
  onAccent: string;
  /** Errors and destructive actions. */
  error: string;
  /** Confirmation, an "added" event, the learner's voice in a transcript. */
  ok: string;
  /** Attention without alarm: a paused session, a degraded wake lock, a warning that is not an error. */
  warn: string;
};

/** The default appearance. Dark is the app's original look and the fallback everywhere. */
export const DARK: Palette = {
  bg: "#0f1115",
  panel: "#1a1d24",
  sunken: "#0c0e12",
  border: "#2a2e37",
  text: "#e8eaed",
  muted: "#9aa0a6",
  faint: "#5a5a5a",
  accent: "#7c9cff",
  onAccent: "#0c0e12",
  error: "#ff6b6b",
  ok: "#6bd49a",
  warn: "#ffb86b",
};

/**
 * Designed, not derived. Inverting the dark palette produces a light theme that fails contrast in
 * the places it matters most — note that `accent` is NOT the dark theme's `#7c9cff`, which does not
 * pass WCAG AA as link text on white.
 */
export const LIGHT: Palette = {
  bg: "#ffffff",
  panel: "#f6f7f9",
  sunken: "#f0f2f5",
  border: "#d9dce3",
  text: "#1a1d24",
  muted: "#5f6368",
  faint: "#767c85",
  accent: "#4361ee",
  onAccent: "#ffffff",
  error: "#c0392b",
  ok: "#1e7d4f",
  warn: "#b26a00",
};

/** The two appearances. There is no third — "follow the system" is a *choice*, not a scheme. */
export type Scheme = "light" | "dark";

/**
 * The stored preference, and the resolved scheme, are the same two values on purpose.
 *
 * Both clients persist under the key `theme` with the literal values below, so an install that has
 * used one is readable by the other's rules. Dark is the default: only an explicit stored `"light"`
 * opts out, which is exactly what the web's pre-paint script does and what the mobile store's
 * synchronous module-load read does.
 */
export const THEME_STORAGE_KEY = "theme";

/** Resolve whatever is in storage. Anything that isn't the string `"light"` means dark. */
export function parseScheme(stored: string | null | undefined): Scheme {
  return stored === "light" ? "light" : "dark";
}

/** The palette for a scheme. */
export function paletteFor(scheme: Scheme): Palette {
  return scheme === "light" ? LIGHT : DARK;
}

/**
 * The CSS custom-property name each role is published under on the web.
 *
 * Declared here rather than in the web app so the mapping is visible from the side that would
 * otherwise silently stop matching: renaming a role without renaming its variable is a compile
 * error, and adding a role without a variable is one too (the record is exhaustive over `Palette`).
 */
export const CSS_VARIABLES: Record<keyof Palette, string> = {
  bg: "--bg",
  panel: "--panel",
  sunken: "--field-bg",
  border: "--border",
  text: "--text",
  muted: "--muted",
  faint: "--faint",
  accent: "--accent",
  onAccent: "--on-accent",
  error: "--error",
  ok: "--ok",
  warn: "--warn",
};
