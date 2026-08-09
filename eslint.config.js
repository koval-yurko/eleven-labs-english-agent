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
  {
    // `src/shared` is the pure core: shapes and rules that both the web client and a future native
    // client must agree on. It has to stay liftable (it becomes `packages/shared` if the repo goes
    // to a workspace — docs/2026-08-09-expo-repo-structure-migration.md), which means dependencies
    // point INWARD ONLY: nothing here may reach into `src/lib` (Supabase/LangChain/Next),
    // `src/app`, or any npm package. Enforced rather than remembered.
    // See docs/2026-08-09-shareable-core-refactor.md.
    files: ["src/shared/**/*.ts", "src/shared/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/lib/*", "**/lib", "**/app/*", "**/app", "@/lib/*", "@/app/*"],
              message:
                "src/shared must not import from src/lib or src/app — it is the pure core and has to stay liftable. Extract the pure part into src/shared instead.",
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
