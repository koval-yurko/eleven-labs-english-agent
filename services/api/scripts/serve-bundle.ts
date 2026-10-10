/**
 * Serve the BUILT bundle (`server.mjs`, from `pnpm build`) locally — the exact file Vercel deploys —
 * so the parity check can run against the artifact rather than the source.
 *
 *   pnpm build && tsx scripts/serve-bundle.ts [port]
 *
 * Env loads from ENV_HOME first, as in src/dev.ts, because modules read env at import time.
 */
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

import { ENV_HOME } from "../../../packages/server/scripts/env-home.mjs";

for (const file of [".env.local", ".env"]) dotenv.config({ path: `${ENV_HOME}${file}`, quiet: true });

const bundle = fileURLToPath(new URL("../server.mjs", import.meta.url));
const { default: app } = (await import(bundle)) as { default: { fetch: (r: Request) => Response | Promise<Response> } };

const port = Number(process.argv[2] ?? process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`services/api BUNDLE listening on http://localhost:${info.port}`);
});
