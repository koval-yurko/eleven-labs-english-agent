"use client";

import { useEffect, useState } from "react";
import { parseScheme, THEME_STORAGE_KEY, type Scheme } from "@tutor/shared/theme";
import { MoonIcon, SunIcon } from "./icons";
import { Button } from "./Button";
import { Tooltip } from "./Tooltip";

/**
 * Header theme switcher. Dark is the default; the choice persists in localStorage
 * under the `theme` key. The actual pre-paint application of the theme happens in a
 * blocking inline script in `layout.tsx` (avoids a flash of the wrong theme on load);
 * this component only reflects and mutates that state after hydration. Both read the same
 * source of truth — the stored value — so this one can re-stamp `<html>` if the attribute
 * ever goes missing rather than inheriting the mistake.
 */
export function ThemeToggle() {
  // Start null so the first (server + client) render matches, then resolve on mount
  // from the stored preference.
  const [theme, setTheme] = useState<Scheme | null>(null);

  useEffect(() => {
    // Read localStorage, NOT the DOM. The `data-theme` attribute is a derived value that a
    // client-side re-render can wipe (React recovering from a hydration mismatch re-renders the
    // root, and <html> comes back with only the attributes RootLayout declares). Trusting it here
    // would let one bad render resolve to "dark" and then persist that below, silently destroying
    // the stored preference. See docs/2026-07-26-light-theme-reverts-to-dark-on-navigation.md.
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Storage can throw (Safari private mode); fall through to the dark default.
    }
    // Re-stamping also heals the attribute if it was stripped before we mounted.
    setTheme(parseScheme(stored));
  }, []);

  useEffect(() => {
    if (!theme) return; // don't clobber the stored choice before it's resolved
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Unwritable storage costs us persistence, not this session's theme.
    }
  }, [theme]);

  const isLight = theme === "light";

  return (
    // The `title=` this replaced was a native tooltip — OS-drawn, and invisible on touch. The label
    // is redundant with aria-label and the button's own text, so a Tooltip is the right shape here
    // (see Tooltip vs InfoPopover).
    <Tooltip label={`Switch to ${isLight ? "dark" : "light"} theme`}>
      <Button
        variant="secondary"
        // Header furniture, not a form control — the compact tier keeps it from setting the
        // header's height. It matches the Select trigger, the app's other non-form control.
        size="sm"
        onClick={() => setTheme(isLight ? "dark" : "light")}
        aria-label={`Switch to ${isLight ? "dark" : "light"} theme`}
      >
        {isLight ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        {isLight ? "Light" : "Dark"}
      </Button>
    </Tooltip>
  );
}
