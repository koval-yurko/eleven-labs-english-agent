import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { DARK, LIGHT, THEME_STORAGE_KEY } from "@tutor/shared/theme";
import { ASSET_VERSION } from "../lib/asset-version";
import { THEME_CSS } from "../lib/theme-css";
import { ThemeToggle } from "./ThemeToggle";
import { NavLink } from "./NavLink";
import { NavProgressBar } from "./NavProgressBar";
import { ServiceWorkerRegister } from "./ServiceWorkerRegister";
import { SyncProvider } from "./SyncProvider";

export const metadata: Metadata = {
  title: "English Tutor",
  description: "Live-story English practice with an ElevenLabs voice tutor.",
  // Next also injects the manifest link from app/manifest.ts; naming it here is explicit + safe.
  manifest: "/manifest.webmanifest",
  // iOS reads apple-touch-icon (not the manifest) for the Home Screen glyph.
  // ?v= busts the immutable HTTP cache on the generated icons — bump ASSET_VERSION
  // whenever the artwork in src/app/pwa/[icon]/route.tsx changes.
  icons: {
    icon: `/pwa/icon-192.png?v=${ASSET_VERSION}`,
    apple: `/pwa/apple-touch-icon.png?v=${ASSET_VERSION}`, // 180×180
  },
  // Emits the Apple standalone-mode meta tags (apple-mobile-web-app-*).
  appleWebApp: {
    capable: true,
    title: "English Tutor",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  // Follows the OS preference for the mobile browser chrome / iOS status bar. (It can't
  // read the in-app localStorage override, so it tracks the system theme only.)
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: DARK.bg },
    { media: "(prefers-color-scheme: light)", color: LIGHT.bg },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // edge-to-edge under the iOS status bar / home indicator
};

// Runs before first paint to stamp data-theme onto <html>, preventing a flash of the
// wrong theme. Dark is the default; only an explicit stored "light" opts out — the rule
// `parseScheme` states for both clients. The key comes from the shared module so the web and the
// phone cannot end up reading different slots; the rule itself is re-spelled rather than imported
// because this string has to be self-contained to run before the bundle does.
const themeInitScript = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});document.documentElement.setAttribute('data-theme',c==='light'?'light':'dark');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The palette, from the shared token table. Before the script below, so the variables the
            stamped attribute selects are already declared. */}
        <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <NavProgressBar />
        <ServiceWorkerRegister />
        <SyncProvider />
        <main>
          <header
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "1.5rem",
            }}
          >
            <NavLink
              href="/lesson-items"
              style={{ fontWeight: 700, fontSize: "1.25rem", textDecoration: "none" }}
            >
              🎧 English Tutor
            </NavLink>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <NavLink href="/lesson-items">Words</NavLink>
              <NavLink href="/lessons">Lessons</NavLink>
              <ThemeToggle />
            </div>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
