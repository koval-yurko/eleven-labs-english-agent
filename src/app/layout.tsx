import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Idiomatic — scaffold",
  description: "Minimal Next.js scaffold: Auth0 · Supabase · ElevenLabs · LangChain + Claude.",
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
