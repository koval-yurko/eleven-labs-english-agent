// Flat ESLint config (ESLint 9) for services/api — the Hono HTTP API.
//
// The HTTP layer over @tutor/server. It may use Hono and Web-standard Request/Response; it may not
// pull Next back in (the whole point of the port), and it may not reach into a client app.
// See docs/2026-10-10-services-split-hono-api.md §3.1.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "server.mjs", "server.mjs.map", ".vercel/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly", Buffer: "readonly" },
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["next", "next/*", "@auth0/nextjs-auth0", "@auth0/nextjs-auth0/*"],
              message:
                "services/api is Hono, not Next. Use the Web-standard Request/Response and lib/after (waitUntil).",
            },
            {
              group: ["**/apps/*", "**/apps/**"],
              message: "services/api must not import from a client app — clients call it over HTTP.",
            },
          ],
        },
      ],
    },
  },
);
