// Where the backend's `.env` / `.env.local` live — the ONE place every script (and sync-agents)
// loads its secrets from: `services/api/`, the deployable that serves the API, so the CLI jobs and
// the API can never drift onto different credentials (D11,
// docs/2026-10-10-services-split-hono-api.md §7). Its `.env.example` is the key registry
// `scripts/env-sync.mjs` checks.
//
// Plain .mjs so `node scripts/migrate.mjs` can import it as well as the tsx scripts.
import { fileURLToPath } from "node:url";

export const ENV_HOME = fileURLToPath(new URL("../../../services/api/", import.meta.url));
