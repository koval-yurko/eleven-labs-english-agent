# Light theme reverts to Dark when navigating Words ↔ Lessons (production only)

**Status:** root-caused on `https://eleven-labs-english-agent.vercel.app`; both fixes applied, not yet deployed.
**Date:** 2026-07-26

---

## Summary

The theme toggle is not broken. A **hydration text mismatch** on `/lesson-items` (React error
`#418`) makes React discard the server-rendered HTML and re-render the root on the client. That
re-render drops the `data-theme` attribute that the pre-paint script had stamped onto `<html>`.
`ThemeToggle` then mounts, reads `data-theme` **from the DOM** as its source of truth, sees no
`"light"`, resolves to `"dark"` — and **writes `theme=dark` back into localStorage**, permanently
destroying the stored preference.

The mismatch itself is a classic one: `new Date(...).toLocaleDateString()` rendered inside a
**client component**. The server formats in the server's timezone (Vercel = UTC), the browser
formats in the user's timezone (`Europe/Kiev`, UTC+3). For any row whose timestamp falls in the
21:00–23:59 UTC window the two disagree by one day.

Locally it cannot reproduce because `next dev` runs in the *same* timezone as the browser, so
both sides format identically and hydration succeeds.

---

## Reproduction (verified)

Logged in as the reported account, browser timezone `Europe/Kiev` (UTC+3):

1. On `/lesson-items`, switch to Light. → `data-theme=light`, `localStorage.theme=light`,
   `body` background `rgb(255,255,255)`. ✅
2. Click **Lessons** → stays Light. ✅ (control — see below)
3. Click **Words** (`/lesson-items`) → **flips to Dark**, and `localStorage.theme` is now `"dark"`.

Step 3 is 100% deterministic — a plain reload of `/lesson-items` with `theme=light` in storage
also flips it and rewrites storage.

### Evidence 1 — the byte-level text diff

Fetching the server HTML from inside the loaded page and diffing the rendered stat lines against
the hydrated DOM:

```
total=24 diffs=1
SRV[0 conversations · 1 lesson · added 7/3/2026]
vs
CLI[0 conversations · 1 lesson · added 7/4/2026]
```

The offending row is the word **`devastating`**, whose `first_added_at` lands after 21:00 UTC on
2026-07-03 (i.e. it was added between 00:00 and 03:00 Kyiv time on 2026-07-04).

### Evidence 2 — the React error

```
Error: Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]=
```

`#418` = *"Hydration failed because the server rendered HTML didn't match the client"*, and
`args[]=text` identifies it as a **text content** mismatch — matching the diff above exactly.

### Evidence 3 — the control page

Same session, `/lessons`, same stored `theme=light`:

```
attr=light | stored=light | dateCells=9 | dateDiffs=0
```

Nine rendered dates, **zero** diffs, no `#418`, and the Light theme survives. `/lessons` is not
immune — it just happens to hold no lesson created in the bad UTC window right now.

### Evidence 4 — environment

```
tz=Europe/Kiev   offsetMin=-180   navigator.language=en-GB   resolvedLocale=en-US
serviceWorker=/sw.js?v=3 (active)
```

The service worker is **not** implicated: navigations are network-first and it never serves a
cached authenticated document. It was the first suspect (it is production-only, matching the
symptom) and was ruled out.

---

## The causal chain

```
ItemsBrowser (a "use client" component) renders
  `added ${new Date(item.first_added_at).toLocaleDateString()}`
        │
        ├─ SSR on Vercel (TZ=UTC)      → "added 7/3/2026"
        └─ hydration in browser (UTC+3) → "added 7/4/2026"
        │
        ▼
React throws #418 (text mismatch) and RECOVERS by discarding the server HTML
and client-rendering the root
        │
        ▼
<html> is re-rendered from RootLayout's props — which are only `lang` and
`suppressHydrationWarning`. The runtime-added `data-theme="light"` does not survive.
        │
        ▼
globals.css falls back to `:root { … }` (the dark block) → page paints DARK
        │
        ▼
ThemeToggle's mount effect runs:
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "light" ? "light" : "dark");   // ← reads DOM, not storage
        │
        ▼
theme = "dark"  →  second effect writes localStorage.setItem("theme", "dark")
        │
        ▼
The user's stored preference is GONE. Dark is now sticky on every page.
```

The last step is what turns a one-frame glitch into a persistent bug. Nothing else in the
codebase touches `data-theme` or the `theme` key — only `src/app/layout.tsx:43` (the pre-paint
script) and `src/app/ThemeToggle.tsx:19-28` — so `ThemeToggle` can only have written `"dark"`
if the attribute was already missing or wrong when its effect ran.

---

## Why it only happens in production

| | local `next dev` | Vercel |
|---|---|---|
| Server timezone | your machine (`Europe/Kiev`) | **UTC** |
| Client timezone | `Europe/Kiev` | `Europe/Kiev` |
| `toLocaleDateString()` agreement | always | **fails for 21:00–23:59 UTC timestamps** |
| Hydration mismatch | never | yes |

**You can reproduce locally** by starting the dev server in the deployment's timezone:

```bash
TZ=UTC pnpm dev
```

Then load `/lesson-items` — the dev overlay will surface the mismatch directly, with the two
conflicting strings named.

## Why it looks directional and intermittent

- It fires on whichever page currently renders a boundary-crossing timestamp. Right now that's
  `/lesson-items` (the word `devastating`), which is why Lessons → Words breaks but
  Words → Lessons did not.
- For a UTC+3 user, ~12.5% of timestamps are poisoned (3 of 24 hours). Any word added or lesson
  created between **00:00 and 03:00 local time** creates a row that will break its page forever.
- Once storage has been rewritten to `dark`, the symptom looks like "Light doesn't stick at all".

### A latent amplifier

`toLocaleDateString()` is called with **no explicit locale**, so it also inherits the *locale*
from each side. Node on Vercel resolves `en-US`; the browser resolves from `navigator.languages`.
This account's browser happens to resolve `en-US` too, so only timezone bites today. A user whose
browser resolves `en-GB` (`04/07/2026`) or `uk-UA` (`04.07.2026`) would mismatch on **every single
row of every page**, making the theme unusable 100% of the time. Note this account's
`navigator.language` is already `en-GB` — it is one ICU resolution away from the constant-failure
case.

---

## Blast radius

Only **client components** re-render during hydration, so only these two are affected. The server
components that format dates (`lessons/[id]/page.tsx`, `lesson-items/[id]/page.tsx`, `demo/page.tsx`)
are safe — their output is serialized into the RSC payload and never recomputed in the browser.

| File | Line | Call | Risk |
|---|---|---|---|
| `src/app/lesson-items/ItemsBrowser.tsx` | 345 | `added ${…toLocaleDateString()}` | **live failure today** |
| `src/app/lesson-items/ItemsBrowser.tsx` | 347 | `last practiced ${…toLocaleDateString()}` | same window |
| `src/app/LessonsList.tsx` | 81 | `{new Date(l.created_at).toLocaleDateString()}` | latent — fires on the next lesson created 00:00–03:00 local |

Beyond the theme, every hydration recovery also throws away and rebuilds the whole client tree on
those pages — a real (if invisible) performance and correctness cost.

---

## The fix — two independent layers (both applied)

Layer 1 removes the trigger; layer 2 makes the theme immune to *any* future hydration failure.

### Layer 1 — stop the mismatch (applied)

Shipped as `src/lib/format-date.ts`, a `formatDate()` helper pinning both inputs
(`toLocaleDateString("en-US", { timeZone: "UTC" })`), used at all three client-component call
sites. Verified deterministic across timezones for the exact timestamp that broke prod:

```
                     new        old (previous behaviour)
UTC                  7/3/2026   7/3/2026
Europe/Kiev          7/3/2026   7/4/2026   ← the observed prod mismatch
America/Los_Angeles  7/3/2026   7/3/2026
```

The three options weighed:

**(a) Pin the timezone and locale** — simplest, but shows UTC dates rather than the user's:

```ts
new Date(item.first_added_at).toLocaleDateString("en-US", { timeZone: "UTC" })
```

**(b) `suppressHydrationWarning`** — the canonical React answer for locale/time text. Keeps the
correct local date and tells React to accept the client value for that subtree instead of erroring.
Works only where the date is the element's own text, so `ItemsBrowser` line 375 would need the
date split out of the joined `stats` string into its own element:

```tsx
<span suppressHydrationWarning>{new Date(item.first_added_at).toLocaleDateString()}</span>
```

**(c) Format after mount** — render a stable ISO/UTC value on the server and swap to the local
format in `useEffect`. Most correct, most code.

**Chose (a).** These are "added / last practiced" audit dates, not appointment times — being off
by up to a day at the edges is invisible, and a single explicit format call kills the whole class
of bug at both call sites, on both pages, for every locale and timezone.

### Layer 2 — make the theme non-corruptible (applied)

`ThemeToggle` treated the **DOM** as its source of truth and wrote that back to storage, so any
hydration hiccup didn't just flash the wrong theme — it silently overwrote the user's saved
preference. It now reads the same source of truth the pre-paint script does (`localStorage`,
wrapped in `try`/`catch` for Safari private mode), and re-stamps `data-theme` from it.

This turns the failure mode from "preference destroyed, permanently dark" into "at worst a brief
flash that self-corrects" — and it repairs the attribute if React ever strips it again.

### Files touched

| File | Change |
|---|---|
| `src/lib/format-date.ts` | **new** — `formatDate()`, the pinned-format helper |
| `src/app/lesson-items/ItemsBrowser.tsx` | both date call sites → `formatDate()` |
| `src/app/LessonsList.tsx` | date call site → `formatDate()` |
| `src/app/ThemeToggle.tsx` | mount effect reads storage, not the DOM; both storage calls guarded |

---

## Verification

Done:

- `formatDate()` returns `7/3/2026` for the boundary timestamp under `UTC`, `Europe/Kiev` and
  `America/Los_Angeles`; the previous call returned `7/4/2026` under `Europe/Kiev` — the exact
  prod divergence, now gone.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` all clean.

Still to do (needs a logged-in browser):

1. `TZ=UTC pnpm dev` → load `/lesson-items`: the dev overlay should be clean, no `#418`.
2. With `TZ=UTC` still set, switch to Light, hard-reload `/lesson-items` and `/lessons`, and
   confirm `localStorage.theme` stays `"light"`.
3. After deploy: on prod set Light and round-trip Words ↔ Lessons several times. Confirm no `#418`
   in the console and that `localStorage.theme` is never rewritten.

Already-affected users have `theme=dark` persisted — they just press the toggle once after the fix
ships. No migration needed.
