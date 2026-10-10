// Flat ESLint config (ESLint 9).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TypeScript files: TS already checks undefined identifiers, and the app uses browser/
    // Node globals (fetch, process, console). Let TS own that check.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // tutor-web is a CLIENT of services/api (D6, docs/2026-10-10-services-split-hono-api.md §5):
      // no server code, no server secrets. Data comes through `lib/api.ts`.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tutor/server", "@tutor/server/*", "**/packages/server/**"],
              message:
                "tutor-web holds no server code. Call services/api through lib/api.ts (apiFetch) instead.",
            },
            {
              group: ["**/services/**", "**/apps/feedback-tracker/**"],
              message: "An app never imports another app or a service — talk to it over HTTP.",
            },
          ],
        },
      ],
    },
  },
  {
    // The hand-rolled service worker runs in a ServiceWorkerGlobalScope (not Node/DOM), so its
    // globals aren't otherwise known to ESLint.
    files: ["public/sw.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
        fetch: "readonly",
        Response: "readonly",
        URL: "readonly",
        Promise: "readonly",
      },
    },
  },
);
