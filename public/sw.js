/*
 * Hand-rolled service worker — see docs/2026-07-04-offline-support-and-sync.md.
 *
 * Goal for this stage: the installed PWA OPENS offline (serves an offline shell instead of the
 * browser's error page) and immutable build assets are cached. Real offline reads/edits arrive
 * later with the IndexedDB mirror + client islands.
 *
 * Deliberately does NOT cache authenticated HTML navigations, so a shared device can't surface
 * one learner's server-rendered page to the next. Cross-origin (ElevenLabs / Supabase), /api,
 * and /auth requests are never intercepted — they hit the network and fail honestly offline.
 *
 * Static & bundler-agnostic: chosen over @serwist/next because its stable webpack plugin does
 * not support Next 16's default Turbopack build. Next's /_next/static/* assets are content-
 * hashed and immutable, so a cache-first strategy needs no build-time precache manifest.
 */

const VERSION = "v2";
const CACHE = `idiomatic-${VERSION}`;
const OFFLINE_URL = "/offline";

// Precache the offline app-shell document AND every /_next/static asset it references, so a cold
// offline open has all the hydration-critical chunks (opportunistic cache-first alone can race and
// miss one, which breaks hydration → the shell can't upgrade to the mirror-backed view).
async function precacheShell(cache) {
  const res = await fetch(OFFLINE_URL, { cache: "no-cache" });
  if (!res.ok) return;
  await cache.put(OFFLINE_URL, res.clone());
  const html = await res.text();
  const urls = new Set();
  const re = /(?:src|href)="(\/_next\/static\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) urls.add(m[1]);
  if (urls.size > 0) await cache.addAll([...urls]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => precacheShell(cache))
      .catch(() => {}), // offline at install-time — cache-first will fill in later
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// Immutable, non-sensitive build/static assets — safe to cache-first.
function isImmutableAsset(url) {
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/pwa/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (convai/db) pass through

  // Never intercept API or auth routes — they must reach the network (and fail honestly offline).
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Immutable build assets: cache-first, populate on miss.
  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Page navigations: network-first; offline, serve the offline shell (NOT a cached auth page).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((r) => r || Response.error()),
      ),
    );
  }
});
