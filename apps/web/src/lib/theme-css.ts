import { CSS_VARIABLES, DARK, LIGHT, type Palette, type Scheme } from "@tutor/shared/theme";

/**
 * The app's custom properties, emitted from the shared token table.
 *
 * `globals.css` used to open with two hand-written `:root` blocks. It no longer declares them at
 * all — it only *consumes* `var(--bg)` and friends — and `RootLayout` inlines what this builds into
 * `<head>`. That is deliberate: with exactly one definition of each variable in the document there
 * is no specificity race between a stylesheet Next injects and a `<style>` tag we control, which
 * two equally-specific `:root` blocks would otherwise have to win on source order.
 *
 * `color-scheme` rides along in the same block. It is not a token — it tells the UA which built-in
 * appearance to use for scrollbars, form controls and the like — but it is per-scheme, and keeping
 * it here means a scheme is described in exactly one place.
 *
 * See docs/2026-08-15-web-design-parity-on-mobile.md §7.
 */
function block(selector: string, palette: Palette, scheme: Scheme): string {
  const declarations = (Object.keys(CSS_VARIABLES) as (keyof Palette)[])
    .map((role) => `${CSS_VARIABLES[role]}:${palette[role]}`)
    .join(";");
  return `${selector}{${declarations};color-scheme:${scheme}}`;
}

/**
 * Dark is the default, so it is bound to bare `:root` as well as to its own attribute — a document
 * whose pre-paint script failed still gets a complete palette rather than a white page with
 * unresolved variables.
 */
export const THEME_CSS = [
  block(':root,:root[data-theme="dark"]', DARK, "dark"),
  block(':root[data-theme="light"]', LIGHT, "light"),
].join("");
