import type { MetadataRoute } from "next";

/**
 * Web app manifest — Next serves this at `/manifest.webmanifest` and injects the
 * `<link rel="manifest">`. Makes the app installable (Add to Home Screen) and, with
 * `display: "standalone"`, launches full-screen without Safari/Chrome chrome.
 *
 * iOS ignores these `icons` for the Home Screen glyph — it reads the apple-touch-icon
 * link set in `layout.tsx` metadata. These icons drive Android/Chrome + the install UI.
 * The PNGs are generated on the fly by `src/app/pwa/[icon]/route.tsx` (swap for real art later).
 *
 * Note: `/manifest.webmanifest` must stay publicly reachable — it is allow-listed in
 * `src/proxy.ts` so the auth gate does not redirect the (often credential-less) manifest fetch.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "English Tutor",
    short_name: "English Tutor",
    description: "Live-story English practice with an ElevenLabs voice tutor.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0b12",
    theme_color: "#0b0b12",
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/pwa/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
