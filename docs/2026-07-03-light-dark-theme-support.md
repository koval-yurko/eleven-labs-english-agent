# Light / Dark theme support — research & implementation plan

**Date:** 2026-07-03
**Goal:** Support both light and dark themes (dark stays the default), add a theme
switcher in the page header, and persist the user's choice across reloads.

---

## 1. Current state (audit)

Theming today is **dark-only**, driven by CSS custom properties plus a scattering of
hardcoded hex values.

### `src/app/globals.css`

A single `:root` block defines the palette:

```css
:root {
  --bg: #0f1115;
  --panel: #1a1d24;
  --text: #e8eaed;
  --muted: #9aa0a6;
  --accent: #7c9cff;
  --warn: #ffb86b;
  --error: #ff6b6b;
  --ok: #6bd49a;
}
```

**Problem:** several rules bypass the variables and hardcode dark hexes, so they will
*not* respond to a theme switch until refactored into tokens:

| Value       | Used for                                    | Locations                                    |
| ----------- | ------------------------------------------- | -------------------------------------------- |
| `#0c0e12`   | input/textarea/`pre` background, button text | `globals.css` (input, button, pre)           |
| `#2a2e37`   | panel / input / pre borders                  | `globals.css` (×3) + inline in lessons pages |

### `src/app/layout.tsx` (server component)

- `RootLayout` is a **server component**. Header is a plain `<a>` inside `<header>`.
- `<html lang="en">` has no `class`/`data-theme` attribute and no `suppressHydrationWarning`.
- `export const viewport.themeColor = "#0b0b12"` — hardcoded dark (drives the mobile
  browser chrome / iOS status bar color).

### `src/app/manifest.ts`

- `background_color: "#0b0b12"`, `theme_color: "#0b0b12"` — PWA install/splash colors,
  dark only.

### Client vs server

Only **two** client components exist (`"use client"`): `AskClaude.tsx` and
`lessons/[id]/LessonTutor.tsx`. Everything else — layout, pages, header — is
server-rendered. This matters because a theme toggle needs client-side state and
`localStorage`, so the switcher itself must be a small client component embedded in the
server layout.

### Inline hardcoded colors (outside CSS)

- `src/app/lessons/[id]/page.tsx:35` — `borderBottom: "1px solid #2a2e37"`
- `src/app/lessons/page.tsx:47` — `borderBottom: "1px solid #2a2e37"`

These should become `var(--border)` so they follow the theme.

---

## 2. The core challenge: theme flash (FOUC) under SSR

This is the one non-obvious part. The page is server-rendered, so the HTML ships with
**no knowledge of the visitor's stored preference** (`localStorage` lives only in the
browser). If we apply the theme with a normal `useEffect`, the sequence is:

1. Server sends dark markup → browser paints **dark**.
2. React hydrates, effect runs, reads `localStorage = "light"` → repaints **light**.

The user sees a dark flash on every load. This is the classic "theme flash of incorrect
color."

**The fix is universal across all approaches:** a tiny **blocking inline script in
`<head>`** that runs *before first paint*, reads `localStorage` (falling back to
`prefers-color-scheme`), and stamps `data-theme` on `<html>`. Because it is synchronous
and inline, it executes before the browser paints, so there is no flash. Every solution
below (library or hand-rolled) uses this same trick — `next-themes` just injects the
script for you.

Because the server renders `<html>` without the attribute and the script adds it before
hydration, add `suppressHydrationWarning` to the `<html>` tag to silence the expected
attribute mismatch warning.

---

## 3. Design decisions

### 3a. Library (`next-themes`) vs hand-rolled

| | `next-themes` | Hand-rolled (~40 lines) |
|---|---|---|
| Dependency | +1 (~2 kB, zero deps) | none |
| FOUC script | injected for you | you write it (small) |
| System-preference tracking | built-in, live-updates | you add a `matchMedia` listener |
| `localStorage` sync across tabs | built-in | you add a `storage` listener |
| App Router support | first-class (`ThemeProvider` in a client boundary) | manual |
| Control / transparency | less | full |

**Recommendation:** For this minimal scaffold, **hand-rolled** is a good fit — it's ~40
lines, no dependency, and the mechanics are fully visible (in keeping with the repo's
"prove the integration is wired" ethos). If you'd rather not own the edge cases
(cross-tab sync, live system-preference changes, SSR script), `next-themes` is the
industry-standard drop-in and equally valid. The plan in §5 shows the hand-rolled path
and notes the `next-themes` shortcut inline.

### 3b. `data-theme` attribute vs `.dark` class

Use a **`data-theme="light|dark"` attribute on `<html>`**. It reads cleanly, pairs
naturally with CSS attribute selectors, and doesn't collide with utility-class
conventions. (Tailwind users often prefer the `class` strategy, but this project uses
plain CSS, so the attribute is the clearer choice.)

### 3c. Two-state vs three-state (add "System")

- **Two-state** (Light ⇄ Dark): simplest; a single toggle button. Persists an explicit
  choice.
- **Three-state** (System / Light / Dark): "System" follows the OS and live-updates when
  the OS flips. Best UX, slightly more code.

**Recommendation:** Ship **three-state** with **default = System, resolving to Dark**
when no OS preference is expressed — this honors "Dark is default" *and* respects users
who set their OS to light. If you want the absolute minimum, two-state with a Dark
default is fine. §5 implements three-state; dropping "System" is a trivial reduction.

---

## 4. Palette: define the light theme

Refactor the two stray hardcoded hexes into tokens (`--border`, `--field-bg`,
`--on-accent`), then define both themes. Proposed values (tune to taste):

```css
:root,
:root[data-theme="dark"] {
  --bg: #0f1115;
  --panel: #1a1d24;
  --text: #e8eaed;
  --muted: #9aa0a6;
  --accent: #7c9cff;
  --warn: #ffb86b;
  --error: #ff6b6b;
  --ok: #6bd49a;
  --border: #2a2e37;   /* was hardcoded */
  --field-bg: #0c0e12; /* was hardcoded (input/pre bg) */
  --on-accent: #0c0e12;/* text on accent buttons */
  color-scheme: dark;  /* native form controls / scrollbars go dark */
}

:root[data-theme="light"] {
  --bg: #ffffff;
  --panel: #f6f7f9;
  --text: #1a1d24;
  --muted: #5f6368;
  --accent: #4361ee;   /* darker so it passes contrast on white */
  --warn: #b26a00;
  --error: #c0392b;
  --ok: #1e7d4f;
  --border: #d9dce3;
  --field-bg: #f0f2f5;
  --on-accent: #ffffff;
  color-scheme: light;
}
```

Then swap the hardcoded uses in `globals.css`:

- `input/textarea` `background: #0c0e12` → `var(--field-bg)`, `border: 1px solid #2a2e37` → `var(--border)`
- `button` `color: #0c0e12` → `var(--on-accent)`
- `pre` `background: #0c0e12` → `var(--field-bg)`, `border` → `var(--border)`
- `.panel` `border: 1px solid #2a2e37` → `var(--border)`
- Inline `#2a2e37` in `lessons/[id]/page.tsx` and `lessons/page.tsx` → `var(--border)`

> Verify contrast: `--accent` `#7c9cff` on a white `--bg` fails WCAG AA for text/links —
> hence the darker `#4361ee` in light mode. Check `--muted`, `--warn`, `--ok`, `--error`
> against the light `--bg` too (values above are starting points).

The `color-scheme` property is important: it tells the browser to render native widgets
(form controls, scrollbars, default `input` backgrounds) in the matching mode.

---

## 5. Implementation plan (hand-rolled, three-state)

### Step 1 — Pre-paint script in `<head>` (kills the flash)

In `layout.tsx`, add `suppressHydrationWarning` to `<html>` and inject a blocking
script *before* `<body>`:

```tsx
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // Runs before first paint. Resolves stored choice (or OS) → data-theme.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
              var c=localStorage.getItem('theme');           // 'light' | 'dark' | 'system' | null
              var sysDark=matchMedia('(prefers-color-scheme: dark)').matches;
              var t=(c==='light'||c==='dark')?c:(c==='system'?(sysDark?'dark':'light'):(sysDark?'dark':'dark'));
              document.documentElement.setAttribute('data-theme',t);
            }catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`,
          }}
        />
      </head>
      <body>{/* …existing main/header… */}</body>
    </html>
  );
}
```

Note the fallback ladder: explicit choice wins; else `system` follows OS; else (no stored
value) **default to dark** per the requirement. Adjust the last branch to `sysDark?'dark':'light'` if you'd prefer a brand-new visitor to follow their OS instead of always starting dark.

### Step 2 — A small `useTheme` hook + `ThemeToggle` client component

`src/app/ThemeToggle.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

type Choice = "system" | "light" | "dark";

function resolve(choice: Choice): "light" | "dark" {
  if (choice !== "system") return choice;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "dark";
  //                                                            ^ default-dark; use "light" to follow OS
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>("system");

  // Sync initial state from what the pre-paint script already applied.
  useEffect(() => {
    setChoice((localStorage.getItem("theme") as Choice) ?? "system");
  }, []);

  // Apply + persist on change; live-track OS when in "system".
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolve(choice));
    localStorage.setItem("theme", choice);
    if (choice !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => document.documentElement.setAttribute("data-theme", resolve("system"));
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [choice]);

  const next: Record<Choice, Choice> = { system: "light", light: "dark", dark: "system" };
  const label: Record<Choice, string> = { system: "🖥️ System", light: "☀️ Light", dark: "🌙 Dark" };

  return (
    <button
      type="button"
      onClick={() => setChoice((c) => next[c])}
      aria-label={`Theme: ${label[choice]}. Click to change.`}
      style={{ marginTop: 0, background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}
    >
      {label[choice]}
    </button>
  );
}
```

(For a two-state toggle, drop `"system"` and cycle `light ⇄ dark`.)

### Step 3 — Put the toggle in the header

In `layout.tsx`, make the header a flex row and drop the client component in:

```tsx
<header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
  <a href="/" style={{ fontWeight: 700, fontSize: "1.25rem", textDecoration: "none" }}>🎧 Idiomatic</a>
  <ThemeToggle />
</header>
```

A server component can render a client component directly — no extra provider needed.

### Step 4 — Refactor palette (see §4)

Split `:root` into dark/light blocks, add the three new tokens, and replace the
hardcoded hexes across `globals.css` and the two inline styles.

### Alternative: `next-themes`

`pnpm add next-themes`, wrap `children` in a `<ThemeProvider attribute="data-theme"
defaultTheme="dark" enableSystem>` inside a thin client boundary, and use its `useTheme()`
in `ThemeToggle`. It injects the pre-paint script and handles cross-tab + system tracking.
Steps 1–2 collapse into provider config; Steps 3–4 are unchanged.

---

## 6. Secondary surfaces (don't forget)

- **`viewport.themeColor` in `layout.tsx`** — currently a single dark hex. Make it
  theme-aware so the mobile browser chrome matches:
  ```ts
  export const viewport: Viewport = {
    themeColor: [
      { media: "(prefers-color-scheme: dark)", color: "#0b0b12" },
      { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    ],
    // …rest unchanged
  };
  ```
  Note this reflects the **OS** preference, not the in-app override — an acceptable
  limitation (it can't read `localStorage`). To make it exactly follow the app choice you'd
  swap the `<meta name="theme-color">` at runtime in the `ThemeToggle` effect.
- **PWA manifest (`manifest.ts`)** — `theme_color`/`background_color` are static per the
  manifest spec; leave dark, or pick a neutral splash color. Not switchable at runtime.
- **iOS `appleWebApp.statusBarStyle`** — currently `"black-translucent"`; fine for both.

---

## 7. Edge cases & testing

- **No flash:** hard-reload in each stored state (light/dark/system) — the pre-paint
  script must prevent any flash. This is the #1 thing to verify.
- **Persistence:** pick Light → reload → still Light. (`localStorage` key `theme`.)
- **System live-update:** with choice = System, flip the OS theme and confirm the app
  follows without reload.
- **Cross-tab (optional):** hand-rolled version above doesn't sync a change to other open
  tabs — add a `window` `storage` listener if desired (`next-themes` does this for free).
- **Contrast:** eyeball every token (`--muted`, `--accent`, states) on the light `--bg`;
  run an a11y contrast check on text/links/buttons.
- **Private-mode `localStorage`:** the `try/catch` in the script covers Safari private-mode
  throwing on access — it falls back to dark.
- **Native controls:** confirm `<select>`, `<input>`, scrollbars flip via `color-scheme`.

---

## 8. Recommended path (summary)

1. Refactor `globals.css` into `data-theme` dark/light blocks + 3 new tokens; replace the
   two inline `#2a2e37` borders (§4).
2. Add the pre-paint script + `suppressHydrationWarning` to `layout.tsx` (§5.1).
3. Add `ThemeToggle.tsx` client component; place it in the header (§5.2–5.3).
4. Make `viewport.themeColor` responsive (§6).
5. Test the flash / persistence / system-tracking matrix (§7).

Default stays **Dark**; users get a header switcher; choice persists via `localStorage`.
Scope is ~1 new small file + edits to `globals.css` and `layout.tsx`. No dependency
required (or add `next-themes` if you'd rather not own the edge cases).
