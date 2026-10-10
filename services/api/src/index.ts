/**
 * Vercel's entry for `services/api`. `build.mjs` bundles this file into `server.mjs`, which Vercel's
 * Hono preset picks up (it checks root `server.*` before `src/*`), so the deployed function is the
 * bundle and `@tutor/*` workspace TypeScript never has to be loaded by Node directly.
 * docs/2026-10-10-services-split-hono-api.md §4.4 (D13).
 */
import "hono";

export { default } from "./app";
