import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";
import { DARK, LIGHT, THEME_STORAGE_KEY } from "@tutor/shared/theme";
import { THEME_CSS } from "../lib/theme-css";
import { ThemeToggle } from "./ThemeToggle";

/**
 * feedback-tracker — the operator's view of debug reports filed from the phone. It was `/ops` inside
 * the web app; it is its own app now (D1, docs/2026-10-10-services-split-hono-api.md §6).
 *
 * Not a learner surface: nothing links here from tutor-web or the phone, and it never links back
 * except to a lesson by id. It reads EVERY learner's reports (D10 — an accepted risk, §6.1).
 */
export const metadata: Metadata = {
  title: "Feedback tracker",
  description: "Debug reports and feedback filed from the English Tutor app.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: DARK.bg },
    { media: "(prefers-color-scheme: light)", color: LIGHT.bg },
  ],
  width: "device-width",
  initialScale: 1,
};

// The same pre-paint theme stamp as tutor-web, so the shared palette applies before hydration.
const themeInitScript = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});document.documentElement.setAttribute('data-theme',c==='light'?'light':'dark');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <main>
          <header
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "1.5rem",
            }}
          >
            <Link
              href="/reports"
              style={{ fontWeight: 700, fontSize: "1.25rem", textDecoration: "none" }}
            >
              Feedback tracker
            </Link>
            <ThemeToggle />
          </header>
          <p className="muted" style={{ marginTop: 0 }}>
            Operator — not part of the app. Every learner&apos;s reports, from the phone.
          </p>
          {children}
        </main>
      </body>
    </html>
  );
}
