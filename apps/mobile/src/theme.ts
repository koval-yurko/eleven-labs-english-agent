import { Storage } from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { useColorScheme } from "react-native";

/**
 * The app's colour tokens — S7 (D71).
 *
 * Before this module every screen hard-coded its hexes: 116 literals, 13 colours, 7 files, and
 * `app.config.ts` declaring `userInterfaceStyle: "automatic"` the whole time. The app was not
 * "unthemed", it was *inconsistent*: it told iOS it supported both appearances and then painted one.
 *
 * What carries over from the web (docs/2026-07-03-light-dark-theme-support.md) is the DECISIONS —
 * three states, System by default, System resolving to **dark** when the OS expresses no
 * preference, and a light palette that was designed rather than derived by inverting the dark one.
 * None of its mechanism carries: the pre-paint script, `data-theme`, `localStorage` cross-tab sync
 * and `next-themes` are all answers to problems a native app does not have.
 *
 * See docs/2026-08-13-expo-s7-ship.md §3.
 */
export type Palette = {
  /** The screen behind everything. */
  bg: string;
  /** Raised fill: inputs, cards, stat tiles. */
  surface: string;
  /** Sunken fill: the log panels on the instrument screens. */
  sunken: string;
  /** Hairline separators between list rows. */
  border: string;
  /** Filled controls — button backgrounds, input and card outlines. */
  control: string;
  /** Body text. */
  text: string;
  /** Secondary text: counts, dates, hints. */
  muted: string;
  /** Tertiary text: placeholders, timestamps, an inactive star. */
  faint: string;
  /** Links, spinners, the tutor's own voice in a transcript. */
  accent: string;
  /** Errors and destructive actions. */
  danger: string;
  /** Confirmation, and the learner's own voice in a transcript. */
  success: string;
  /** Attention without alarm: a favourite star, an app-state change, the recovery card. */
  warning: string;
};

/**
 * The dark palette is not new — these are exactly the hexes the screens already used, re-keyed by
 * role. One merge: the lessons list's preview line was `#6E6E6E`, a thirteenth grey used once and
 * a shade off `faint`. It became `faint`.
 */
export const DARK: Palette = {
  bg: "#101014",
  surface: "#1B1B22",
  sunken: "#16161C",
  border: "#26262E",
  control: "#2A2A34",
  text: "#E6E6E6",
  muted: "#8A8A8A",
  faint: "#5A5A5A",
  accent: "#7FB2FF",
  danger: "#FF7A7A",
  success: "#7DFF9B",
  warning: "#FFC46B",
};

/**
 * The light palette starts from the web's (`globals.css` `[data-theme="light"]`), which was already
 * tuned for contrast on white — including the part that matters most: the accent is NOT the dark
 * theme's `#7FB2FF`, because that fails WCAG AA as link text on white. `faint` is the one value
 * with no web counterpart; it is a step lighter than `muted` and still passes AA at 13pt.
 */
export const LIGHT: Palette = {
  bg: "#FFFFFF",
  surface: "#F6F7F9",
  sunken: "#F0F2F5",
  border: "#D9DCE3",
  control: "#E4E7EC",
  text: "#1A1D24",
  muted: "#5F6368",
  faint: "#767C85",
  accent: "#4361EE",
  danger: "#C0392B",
  success: "#1E7D4F",
  warning: "#B26A00",
};

export type ThemeChoice = "system" | "light" | "dark";
export type Scheme = "light" | "dark";

const KEY = "theme";

function parse(raw: string | null): ThemeChoice {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/**
 * Read once, synchronously, at module load.
 *
 * `expo-sqlite/kv-store` is the reason there is no new dependency here: the app already depends on
 * expo-sqlite, and this store offers real synchronous accessors. Synchronous matters — an async
 * read would resolve a frame or two after the first render, and the override would land as a
 * visible repaint. That is the native shape of the flash the web's pre-paint script exists to
 * prevent, and the fix is the same idea: know the answer before painting.
 *
 * Guarded, because this runs at module scope: a throw here is not a wrong colour, it is a white
 * screen before anything has rendered. An unreadable store is not worth that — the app falls back to
 * following the system, which is the default anyway.
 */
let choice: ThemeChoice = readStoredChoice();

function readStoredChoice(): ThemeChoice {
  try {
    return parse(Storage.getItemSync(KEY));
  } catch {
    return "system";
  }
}

/**
 * A module-level store rather than a React context, deliberately.
 *
 * The theme is one string, read by every screen and written from one place. A provider would put a
 * second wrapper around the tree that exists only to move it, and `useSyncExternalStore` is what
 * React 19 offers for exactly this: an external mutable value, subscribed to, torn-write-free.
 * `useColorScheme()` is already such a store — this one sits beside it rather than above it.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function snapshot(): ThemeChoice {
  return choice;
}

/**
 * Set the override and persist it.
 *
 * The in-memory value is truth and is updated first, so a storage failure costs the preference at
 * next launch rather than the tap the learner just made.
 */
export function setThemeChoice(next: ThemeChoice): void {
  if (next === choice) return;
  choice = next;
  for (const listener of listeners) listener();
  try {
    Storage.setItemSync(KEY, next);
  } catch {
    // Not worth surfacing: the appearance already changed, and it will simply not survive a restart.
  }
}

/** The learner's stored preference — one of the three states, not the resolved scheme. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * The appearance to actually paint.
 *
 * `useColorScheme()` returns `null` when the OS expresses no preference, and that case resolves to
 * **dark** — the app's original and default look. Only an explicit system *light* opts out of it.
 */
export function useScheme(): Scheme {
  const stored = useThemeChoice();
  const system = useColorScheme();
  if (stored !== "system") return stored;
  return system === "light" ? "light" : "dark";
}

/**
 * The palette for the current appearance.
 *
 * `StyleSheet.create` is static, so screens pair this with a memoised factory:
 *
 * ```ts
 * const theme = useTheme();
 * const styles = useMemo(() => makeStyles(theme), [theme]);
 * ```
 *
 * The two palettes are module constants, so `theme` is referentially stable per scheme and the
 * memo recomputes exactly when the appearance flips.
 */
export function useTheme(): Palette {
  return useScheme() === "light" ? LIGHT : DARK;
}
