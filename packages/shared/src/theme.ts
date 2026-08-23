/** The colour tokens — one table, both clients.
 *  See ../README.md#theme. */
export type Palette = {
  bg: string;
  panel: string;
  sunken: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  onAccent: string;
  error: string;
  ok: string;
  warn: string;
};

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

export type Scheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

export function parseScheme(stored: string | null | undefined): Scheme {
  return stored === "light" ? "light" : "dark";
}

export function paletteFor(scheme: Scheme): Palette {
  return scheme === "light" ? LIGHT : DARK;
}

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
