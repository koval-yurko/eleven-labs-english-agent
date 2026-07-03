import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Idiomatic — English tutor",
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
    title: "Idiomatic",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0b12",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // edge-to-edge under the iOS status bar / home indicator
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>
          <header style={{ marginBottom: "1.5rem" }}>
            <a href="/" style={{ fontWeight: 700, fontSize: "1.25rem", textDecoration: "none" }}>
              🎧 Idiomatic
            </a>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
