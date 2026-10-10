/**
 * Local dev server: `pnpm dev` (tsx watch).
 *
 * Port 3000 — the port the Next API used — so the phone's LAN `apiBaseUrl` and the client apps'
 * `API_BASE_URL` are unchanged by the services split. Override with PORT.
 *
 * Env: loads `.env` / `.env.local` from `ENV_HOME` (packages/server/scripts/env-home.mjs, i.e.
 * this package) — the same file the CLI jobs read — before the app is imported, because several
 * modules read env at load.
 */
import { serve } from "@hono/node-server";
import dotenv from "dotenv";

import { ENV_HOME } from "../../../packages/server/scripts/env-home.mjs";

for (const file of [".env.local", ".env"]) dotenv.config({ path: `${ENV_HOME}${file}`, quiet: true });

const { default: app } = await import("./app");

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`services/api listening on http://localhost:${info.port}`);
});
