# Making the app installable on iOS (PWA / Add to Home Screen)

**Date:** 2026-07-03
**Goal:** Add the web app to an iPhone/iPad Home Screen so it launches full-screen from an
icon — no Safari chrome, no typing the URL.

## TL;DR

For a **basic installable app** (icon + standalone launch), you do **not** need a service
worker or any extra library. You need exactly three things:

1. A **web manifest** (`app/manifest.ts`) — name, colors, `display: "standalone"`, icons.
2. **Icons** — a 180×180 `apple-icon.png` (iOS ignores the manifest for the icon) plus
   192/512 PNGs for the manifest (Android/Chrome).
3. **Apple meta tags** in `layout.tsx` metadata — `apple-mobile-web-app-capable`, title,
   status-bar style.

A **service worker** (offline caching, install prompt, push) is a *separate, optional* upgrade
— see "Optional: offline + install prompt" below.

Our stack (Next 16 App Router, React 19) has first-class support for all of this via file
conventions and the `Metadata` API — no `next-pwa`/webpack plugin required.

> **✅ Implemented (2026-07-03).** In this repo the three steps landed as:
> `src/app/manifest.ts` (manifest) · `src/app/pwa/[icon]/route.tsx` (icons generated on the fly
> with `next/og` — a gradient "Id" placeholder, no binary assets) · `src/app/layout.tsx`
> (`appleWebApp` + `viewport`) · `src/proxy.ts` (allow-lists `/manifest.webmanifest` past the auth
> gate; `*.png` icons are already excluded by the matcher). Auth0 session lifetime fixed in
> `src/lib/auth0.ts`. The icon code path replaces the two *options* sketched in Step 2 below —
> swap in real artwork later by dropping static files in `public/`.

---

## Context: what iOS actually requires (2026)

- **iOS 16.4+** supports web push for home-screen-installed web apps.
- **iOS 26 / iPadOS 26**: by default *every* site added to the Home Screen opens **as a web
  app** (standalone). Older iOS still needs `apple-mobile-web-app-capable` to drop the Safari
  chrome, so we set it regardless.
- **iOS does not use the manifest `icons` for the Home Screen icon.** It reads the
  `<link rel="apple-touch-icon">`. A single **180×180 PNG** covers all modern iPhones/iPads.
  (Manifest icons are still needed for Android/Chrome and the install UI.)
- iOS has **no `beforeinstallprompt`** — there is no programmatic "Install" button. The user
  installs via Safari → **Share → Add to Home Screen**. We can show a hint telling them how.

---

## Step 1 — Web manifest (`src/app/manifest.ts`)

Next generates `/manifest.webmanifest` from this file and injects the `<link>` automatically.

```ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Idiomatic — English tutor",
    short_name: "Idiomatic", // shown under the icon; keep ≤12 chars
    description: "Live-story English practice with an ElevenLabs voice tutor.",
    start_url: "/",
    display: "standalone", // full-screen, no browser UI
    background_color: "#000000", // splash background
    theme_color: "#000000", // status bar tint (Android)
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable", // Android adaptive icon (safe-zone padded)
      },
    ],
  };
}
```

## Step 2 — Icons

We have **no `public/` dir yet** — create it. Two valid approaches; pick one:

**A. `public/` static files (simplest, explicit):**
```
public/
  apple-icon.png       180×180  ← iOS Home Screen icon (the important one)
  icon-192.png         192×192  ← manifest (Android/Chrome)
  icon-512.png         512×512  ← manifest + install UI + iOS splash source
  icon-512-maskable.png 512×512 ← Android adaptive (logo in center ~80% safe zone)
  favicon.ico          (optional, browser tab)
```
With this approach, add the apple-touch-icon link yourself in metadata (Step 3).

**B. Next file conventions in `src/app/` (auto-wired, no manual link tags):**
```
src/app/
  icon.png        any square (e.g. 512×512) → <link rel="icon">
  apple-icon.png  180×180                    → <link rel="apple-touch-icon">
```
Next auto-generates the correct `<link>` tags. This is the cleaner option — **recommended**.
If you use B, you can skip the manual `appleWebApp.startupImage`/icon links in Step 3.

> Generating icons: export a 1024×1024 master PNG, then downscale. Tools like
> [appiconkitchen.com](https://www.appiconkitchen.com/app-icon-size-guide) or `sharp`/ImageMagick
> (`magick master.png -resize 180x180 apple-icon.png`) work. Maskable = keep the logo within the
> center ~80% so Android's mask doesn't clip it.

## Step 3 — Apple meta tags (`src/app/layout.tsx`)

Extend the existing `metadata` export. The `appleWebApp` block emits the Apple-specific tags:

```ts
export const metadata: Metadata = {
  title: "Idiomatic — English tutor",
  description: "Live-story English practice with an ElevenLabs voice tutor.",
  manifest: "/manifest.webmanifest", // Next also injects this from manifest.ts
  appleWebApp: {
    capable: true, // → apple-mobile-web-app-capable = yes (standalone on older iOS)
    title: "Idiomatic", // Home Screen label
    statusBarStyle: "black-translucent", // or "default" / "black"
  },
};

// Recommended in Next 15/16: viewport + theme color live in a separate export
export const viewport: Viewport = {
  themeColor: "#000000",
  // Optional: make it feel native (edge-to-edge, no user zoom)
  // width: "device-width", initialScale: 1, viewportFit: "cover",
};
```
(Add `import type { Viewport } from "next";`.)

If you went with **public/ (approach A)** rather than the `app/apple-icon.png` convention, also
add the icon link explicitly:
```ts
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-icon.png", // 180×180
  },
```

That's the whole minimum. Deploy, open in **Safari on iOS** (not Chrome), Share → **Add to
Home Screen**. It launches standalone from the icon.

---

## ⚠️ Auth0 gotcha in standalone mode (read before shipping)

This app gates on Auth0 login. Standalone PWAs are historically where OAuth breaks. Two things:

1. **Session must survive the OAuth round-trip and outlive a single visit.** Tapping "Log in"
   is a full-page redirect to Auth0's `/authorize`; iOS keeps that redirect inside the installed
   app context (same-window navigation, not `window.open`), so the return to our callback works —
   *provided the session cookie is `SameSite=Lax`* (top-level GET navigations send Lax cookies;
   `Strict` would drop them). `Lax` is the `@auth0/nextjs-auth0` v4 default.
   **The bigger PWA problem is session lifetime:** the SDK default inactivity window is **1 day**,
   so tapping the icon after a day away re-prompts login — which feels broken for an "app."
   **✅ Fixed in code** (`src/lib/auth0.ts`): rolling session, **30-day inactivity / 90-day
   absolute**, `sameSite: "lax"` pinned. See the config section below.
2. **App URL must match the Auth0 dashboard.** The PWA loads `start_url: "/"` on our production
   origin, so no new origin/scheme is introduced — but the prod domain must be registered as a
   callback/logout/web-origin URL. See "Auth0 / OAuth configuration to update" below.

Quick test: install to Home Screen, cold-launch, log in, force-quit, relaunch — you should stay
logged in. If login bounces back to logged-out, it's cookie `SameSite`/domain or a missing
callback URL, **not** the PWA manifest.

Also sanity-check the **ElevenLabs mic permission**: iOS grants `getUserMedia` to installed web
apps, but the permission prompt only appears on a user gesture and only over HTTPS — both already
true in prod. Verify the convai session starts inside the standalone shell.

---

## Auth0 / OAuth configuration to update

Nothing about the PWA changes *which* OAuth URLs are needed — a standalone web app reuses the
same origin as the browser app. The point of this section is: **make sure prod is fully
registered, and know exactly which knobs the session-lifetime fix touched.**

### A. Code (already applied)

`src/lib/auth0.ts` now passes a `session` block to `Auth0Client`:

```ts
session: {
  rolling: true,
  inactivityDuration: 30 * 24 * 60 * 60, // 30 days — extends on each use
  absoluteDuration: 90 * 24 * 60 * 60,   // 90 days — hard cap
  cookie: { sameSite: "lax" },           // required for the OAuth callback
},
```

> These durations apply to sessions **minted after deploy** — existing sessions keep their old
> (1-day) window until the next login. So after deploying, log out/in once on the device to
> adopt the longer session, then test cold relaunch.

### B. Environment variables (Vercel + local `.env`)

`@auth0/nextjs-auth0` **v4** derives the redirect/callback URLs from `APP_BASE_URL` (this repo
already uses it — *not* the v3 `AUTH0_BASE_URL`). It must equal the exact origin the app is
served from, per environment:

| Var | Local dev | Production (Vercel) |
| --- | --- | --- |
| `APP_BASE_URL` | `http://localhost:3000` | `https://<your-prod-domain>` (the canonical one) |
| `AUTH0_DOMAIN` | `yurko-kovalchuk.eu.auth0.com` | same |
| `AUTH0_CLIENT_ID` | app client id | same (or a separate prod app) |
| `AUTH0_CLIENT_SECRET` | secret | secret |
| `AUTH0_SECRET` | `openssl rand -hex 32` | a **different** 32-byte hex in prod |

- `APP_BASE_URL` must be **https** in prod — the SDK sets the session cookie `Secure` only when
  the base URL is https, and iOS standalone PWAs require Secure cookies.
- If you use Vercel preview deploys and want login to work on them too, either set
  `APP_BASE_URL` per-environment or add the preview domains to the Auth0 URLs below.

### C. Auth0 Dashboard → Applications → *[your app]* → Settings

The SDK v4 mounts its routes under `/auth`, so the callback path is **`/auth/callback`** (not the
v3 `/api/auth/callback`). Add both dev and prod. Use comma-separated lists:

| Field | Value(s) |
| --- | --- |
| **Allowed Callback URLs** | `http://localhost:3000/auth/callback`, `https://<your-prod-domain>/auth/callback` |
| **Allowed Logout URLs** | `http://localhost:3000`, `https://<your-prod-domain>` |
| **Allowed Web Origins** | `http://localhost:3000`, `https://<your-prod-domain>` |
| **Application Login URI** *(optional)* | `https://<your-prod-domain>/auth/login` (prod only; Auth0 forbids `http`/localhost here) |

- **Allowed Callback URLs** — where Auth0 returns the auth code. Missing prod entry → the classic
  `Callback URL mismatch` error after login.
- **Allowed Logout URLs** — where `/auth/logout` may redirect back to. Missing → logout errors.
- **Allowed Web Origins** — enables silent token refresh (`checkSession`) from that origin.
- Leave **Application Type = Regular Web Application** and **Token Endpoint Auth = Post** (this is
  a confidential server-side app; the secret stays server-only).

If `AUTH0_AUDIENCE` is set (for Supabase RLS via Auth0-issued JWTs), also confirm that API exists
under **Auth0 → APIs** and that "Allow Offline Access" is enabled (we request `offline_access`).

### D. Verify

```bash
# After deploy, from the prod origin:
curl -sI https://<your-prod-domain>/auth/login | grep -i location   # → 302 to {AUTH0_DOMAIN}/authorize
```
Then on the installed PWA: log in → force-quit → relaunch next day → still signed in.

---

## Optional: offline + real install prompt (Serwist)

Only needed if you want offline caching, background sync, or web-push. For "fast access from an
icon" you can skip this entirely.

- Use **`@serwist/next`** (the maintained successor to the abandoned `next-pwa`). It wires a
  service worker into the Next 16 build.
- Add a `app/sw.ts` service worker + `withSerwist()` in `next.config.ts`.
- Gives you offline precaching and enables Android's `beforeinstallprompt` install button
  (iOS still has no programmatic prompt — only Share → Add to Home Screen).
- Caveat for us: be careful **not** to cache authenticated pages or API responses in the SW, or
  logged-out users could see stale owner-scoped data. Scope runtime caching to static assets.

---

## Optional: "Add to Home Screen" hint UI

Since iOS has no install button, a small one-time banner improves discovery. Detect:
```ts
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches
  || (navigator as any).standalone === true; // iOS legacy flag
// Show the hint only when isIos && !isStandalone.
```
Render: *"Tap the Share icon, then **Add to Home Screen**."*

---

## Verification checklist

- [ ] `pnpm build` — `/manifest.webmanifest` served, `<link rel="manifest">` present.
- [ ] `<link rel="apple-touch-icon">` points to a real 180×180 PNG (View Source on prod).
- [ ] Lighthouse → "Installable" passes (Chrome DevTools, mobile emulation).
- [ ] Real iPhone via **Safari**: Share → Add to Home Screen → launches full-screen, no URL bar.
- [ ] Correct icon + short name on the Home Screen.
- [ ] Auth0 login survives cold launch + relaunch (see gotcha above).
- [ ] ElevenLabs mic works inside the installed app.

## Sources

- [Next.js — Guides: PWAs](https://nextjs.org/docs/app/guides/progressive-web-apps)
- [Next.js — Metadata files: manifest.json / manifest.ts](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/manifest)
- [Apple — Configuring Web Applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html)
- [Michael Tsai — Web Apps in iOS 26](https://mjtsai.com/blog/2025/10/03/web-apps-in-ios-26/)
- [MacRumors — iOS 26: Add Web App to Home Screen](https://www.macrumors.com/how-to/save-safari-bookmark-web-app-iphone-home-screen/)
- [App Icon Size Guide 2026](https://www.appiconkitchen.com/app-icon-size-guide)
- [Serwist (next-pwa successor)](https://serwist.pages.dev/)
