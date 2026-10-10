/**
 * Bundle `services/api` into `server.mjs` for Vercel. docs/2026-10-10-services-split-hono-api.md
 * §4.4 (D13).
 *
 * Why a build step at all: `@tutor/shared` and `@tutor/server` ship raw TypeScript through
 * `"exports": { "./*": "./src/*.ts" }` with extensionless relative imports. Vercel's Node builder
 * compiles file-by-file and never rewrites a package's `exports`, so an unbundled function asks for
 * `src/*.ts` files that were never shipped (ERR_MODULE_NOT_FOUND — reproduced in the step 0 spike).
 *
 * Why npm packages are bundled TOO (unlike the spike): the workspace sets
 * `hoistingLimits: workspaces`, so `@tutor/server`'s own dependencies (Supabase, LangChain,
 * LangSmith, Anthropic) live in `packages/server/node_modules`. Left external, the bundle at
 * `services/api/server.mjs` would resolve them from `services/api/node_modules`, where they are
 * not — a deploy that builds green and 500s. Inlining them removes the question.
 *
 * Kept external, on purpose:
 *   - `hono`: Vercel's framework detection needs a real `import "hono"` in the entry.
 *   - `@vercel/functions`: `waitUntil` reads the request context the platform installs.
 *   - `@elevenlabs/elevenlabs-js`: ~7.5 MB, 63% of the bundle, needed by one webhook only. The
 *     route `import()`s it lazily so a cold start does not parse it (measured: see the step 3
 *     notes in the doc).
 * All three are direct dependencies of this package, so NFT traces them from its node_modules.
 *
 * `server.mjs` at the package root: Vercel's entrypoint search checks `app`, `index`, `server`,
 * `main` before `src/*`, so the bundle wins over `src/index.ts` without any config.
 */
import { build } from "esbuild";

const EXTERNAL = ["hono", "hono/*", "@vercel/functions", "@elevenlabs/elevenlabs-js"];

await build({
  entryPoints: ["src/index.ts"],
  outfile: "server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  external: EXTERNAL,
  // Bundled CommonJS calls `require` for Node builtins; an ESM bundle has no `require` unless it is
  // made one. The standard esbuild banner for exactly this.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
  metafile: true,
});
