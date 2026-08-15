import {
  DARK,
  LIGHT,
  paletteFor,
  parseScheme,
  THEME_STORAGE_KEY,
  type Palette,
  type Scheme,
} from "@tutor/shared/theme";
import { Storage } from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";

/**
 * The appearance store.
 *
 * **The palettes are gone from this file.** They live in `@tutor/shared/theme` now, alongside the
 * web's, because the two had silently drifted on every dark value while claiming to be the same
 * design (docs/2026-08-15-web-design-parity-on-mobile.md §3.3, §7). What stays here is the part
 * that is genuinely native: where the preference is kept, when it is read, and how a component
 * subscribes to it.
 *
 * **Two states, not three.** This used to offer System / Light / Dark, which is the better iOS
 * citizen and was argued for on those grounds. The web has a two-state switch, the brief is one
 * design across both, so System is gone: `parseScheme` — the same function the web's pre-paint
 * script re-spells — resolves anything that is not the literal `"light"` to dark. An install that
 * stored `"system"` therefore launches dark, which is what it was already doing whenever the phone
 * was dark or undecided. No migration, no `useColorScheme()`.
 */
export { DARK, LIGHT, type Palette, type Scheme };

/**
 * Read once, synchronously, at module load.
 *
 * `expo-sqlite/kv-store` is the reason there is no new dependency here: the app already depends on
 * expo-sqlite, and this store offers real synchronous accessors. Synchronous matters — an async
 * read would resolve a frame or two after the first render and the preference would land as a
 * visible repaint. That is the native shape of the flash the web's pre-paint script exists to
 * prevent, and the fix is the same idea: know the answer before painting.
 *
 * Guarded, because this runs at module scope: a throw here is not a wrong colour, it is a white
 * screen before anything has rendered. An unreadable store falls back to dark, the default anyway.
 */
let scheme: Scheme = readStoredScheme();

function readStoredScheme(): Scheme {
  try {
    return parseScheme(Storage.getItemSync(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

/**
 * A module-level store rather than a React context, deliberately.
 *
 * The theme is one string, read by every screen and written from one place. A provider would put a
 * second wrapper around the tree that exists only to move it, and `useSyncExternalStore` is what
 * React 19 offers for exactly this: an external mutable value, subscribed to, torn-write-free.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function snapshot(): Scheme {
  return scheme;
}

/**
 * Set the appearance and persist it.
 *
 * The in-memory value is truth and is updated first, so a storage failure costs the preference at
 * next launch rather than the tap the learner just made.
 */
export function setScheme(next: Scheme): void {
  if (next === scheme) return;
  scheme = next;
  for (const listener of listeners) listener();
  try {
    Storage.setItemSync(THEME_STORAGE_KEY, next);
  } catch {
    // Not worth surfacing: the appearance already changed, and it will simply not survive a restart.
  }
}

/** Flip it — the whole of what the header's toggle does. */
export function toggleScheme(): void {
  setScheme(scheme === "light" ? "dark" : "light");
}

/** The appearance to paint. */
export function useScheme(): Scheme {
  return useSyncExternalStore(subscribe, snapshot);
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
  return paletteFor(useScheme());
}
