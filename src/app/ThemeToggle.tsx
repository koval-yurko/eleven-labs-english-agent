"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * Header theme switcher. Dark is the default; the choice persists in localStorage
 * under the `theme` key. The actual pre-paint application of the theme happens in a
 * blocking inline script in `layout.tsx` (avoids a flash of the wrong theme on load);
 * this component only reflects and mutates that state after hydration.
 */
export function ThemeToggle() {
  // Start null so the first (server + client) render matches, then resolve on mount
  // from whatever the pre-paint script already stamped onto <html>.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "light" ? "light" : "dark");
  }, []);

  useEffect(() => {
    if (!theme) return; // don't clobber the stored choice before it's resolved
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
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
      }}
    >
      {isLight ? "☀️ Light" : "🌙 Dark"}
    </button>
  );
}
