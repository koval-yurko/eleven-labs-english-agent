import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ThemeToggle } from "./ThemeToggle";
import { ServiceWorkerRegister } from "./ServiceWorkerRegister";
import { SyncProvider } from "./SyncProvider";

export const metadata: Metadata = {
  title: "English Tutor",
  description: "Live-story English practice with an ElevenLabs voice tutor.",
  // Next also injects the manifest link from app/manifest.ts; naming it here is explicit + safe.
  manifest: "/manifest.webmanifest",
  // iOS reads apple-touch-icon (not the manifest) for the Home Screen glyph.
  icons: {
    icon: "/pwa/icon-192.png",
    apple: "/pwa/apple-touch-icon.png", // 180×180
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
    { media: "(prefers-color-scheme: dark)", color: "#0b0b12" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // edge-to-edge under the iOS status bar / home indicator
};

// Runs before first paint to stamp data-theme onto <html>, preventing a flash of the
// wrong theme. Dark is the default; only an explicit stored "light" opts out.
const themeInitScript = `(function(){try{var c=localStorage.getItem('theme');document.documentElement.setAttribute('data-theme',c==='light'?'light':'dark');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
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
            <a href="/" style={{ fontWeight: 700, fontSize: "1.25rem", textDecoration: "none" }}>
              🎧 English Tutor
            </a>
            <ThemeToggle />
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
