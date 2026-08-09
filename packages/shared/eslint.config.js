// Flat ESLint config (ESLint 9) for @tutor/shared — the pure core.
//
// This package holds the shapes and rules that the web client and a future native client must both
// agree on. It has to stay liftable, which means dependencies point INWARD ONLY: nothing here may
// reach into an app, and nothing here may import an npm package (its `dependencies` are empty by
// design). Enforced rather than remembered.
//
// See docs/2026-08-09-expo-repo-structure-migration.md §5 and §4 step 3.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything in the package, including the check harness at the root.
    files: ["**/*.ts"],
    rules: {
      // TS already checks undefined identifiers, and this code uses platform globals
      // (URLSearchParams, console). Let TS own that check.
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The boundary applies to `src/**` ONLY — that is the pure core. `check.ts` sits outside it
    // precisely so it can be a Node script (it imports `node:process`) without punching a hole
    // in the rule below. Same reason it has its own tsconfig.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/lib/*", "**/lib", "**/app/*", "**/app"],
              message:
                "@tutor/shared must not import from an app — it is the pure core and has to stay liftable. Extract the pure part into this package instead.",
            },
            {
              // Anything not starting with "." is a bare specifier, i.e. an npm package.
              regex: "^[^.]",
              message:
                "@tutor/shared has zero runtime dependencies. If you need a package here, the logic probably belongs on the server instead — see docs/2026-08-09-expo-repo-structure-migration.md §5.",
            },
          ],
        },
      ],
    },
  },
);
