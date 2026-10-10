// Flat ESLint config (ESLint 9) for @tutor/server — the backend domain core.
//
// Dependencies point INWARD: this package may use @tutor/shared and server-side npm packages, but
// never an app, and never a web framework. The HTTP layer (Next route handlers today, Hono after the
// port) wraps this package; if code here needs `after()`, `NextResponse` or a Hono context, the
// transport is leaking in — inject it instead (see src/defer.ts).
// See docs/2026-10-10-services-split-hono-api.md §3.1 (D5).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const BOUNDARY = [
  {
    group: ["**/apps/*", "**/apps/**", "**/services/*", "**/services/**"],
    message:
      "@tutor/server must not import from an app or a service — they depend on it, not the other way round.",
  },
  {
    group: ["next", "next/*", "@auth0/nextjs-auth0", "@auth0/nextjs-auth0/*"],
    message:
      "@tutor/server is framework-free. Keep Next (after, NextResponse, revalidatePath, the Auth0 cookie session) in the HTTP layer and inject what you need — see src/defer.ts.",
  },
  {
    group: ["hono", "hono/*", "@vercel/functions"],
    message:
      "@tutor/server is framework-free. Hono and waitUntil belong to services/api, which injects them.",
  },
  {
    group: ["react", "react/*", "react-dom", "react-dom/*", "dexie", "dexie-react-hooks"],
    message: "@tutor/server runs on the server only. UI and browser storage belong to a client app.",
  },
];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "scripts/lexicon/data/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        Buffer: "readonly",
      },
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-restricted-imports": ["error", { patterns: BOUNDARY }],
    },
  },
);
