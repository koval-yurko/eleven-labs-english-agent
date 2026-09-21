/**
 * Loads `apps/voice-worker/.env` into `process.env`, if it exists. Import this FIRST from every
 * entrypoint (`agent.ts`, `smoke.ts`, `stt-language-check.ts`), before anything that reads a key.
 *
 * The worker is a separate deployable (research doc §10.1): it never reads `apps/web/.env`, and
 * on LiveKit Cloud its secrets arrive through `lk agent update-secrets` instead of a file. So a
 * missing file is normal, not an error. A variable already set in the shell wins over the file.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
