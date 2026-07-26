"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "./icons";

type Theme = "light" | "dark";

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
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    // Read localStorage, NOT the DOM. The `data-theme` attribute is a derived value that a
    // client-side re-render can wipe (React recovering from a hydration mismatch re-renders the
    // root, and <html> comes back with only the attributes RootLayout declares). Trusting it here
    // would let one bad render resolve to "dark" and then persist that below, silently destroying
    // the stored preference. See docs/2026-07-26-light-theme-reverts-to-dark-on-navigation.md.
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("theme");
    } catch {
      // Storage can throw (Safari private mode); fall through to the dark default.
    }
    // Re-stamping also heals the attribute if it was stripped before we mounted.
    setTheme(stored === "light" ? "light" : "dark");
  }, []);

  useEffect(() => {
    if (!theme) return; // don't clobber the stored choice before it's resolved
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // Unwritable storage costs us persistence, not this session's theme.
    }
  }, [theme]);

  const isLight = theme === "light";

  return (
    <button
      type="button"
      onClick={() => setTheme(isLight ? "dark" : "light")}
      aria-label={`Switch to ${isLight ? "dark" : "light"} theme`}
      title={`Switch to ${isLight ? "dark" : "light"} theme`}
      style={{
        marginTop: 0,
        background: "transparent",
        color: "var(--text)",
        border: "1px solid var(--border)",
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
      }}
    >
      {isLight ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      {isLight ? "Light" : "Dark"}
    </button>
  );
}
