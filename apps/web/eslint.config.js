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
    },
  },
  // NOTE: the pure-core boundary rule that used to live here (scoped to `src/shared/**`) moved out
  // with the folder — it is now `packages/shared/eslint.config.js`, where it also blocks npm imports.
  // See docs/2026-08-09-expo-repo-structure-migration.md §4 step 3.
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
  {
    // Node CLI scripts (migrations, smoke tests) run under Node, not the browser.
    files: ["scripts/**"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
);
