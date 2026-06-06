// Hardening check (T054): scan the built client bundle for leaked server secrets.
// Server-only values (provider keys, service-role key, Auth0 secret, DB URL) must never
// reach the browser (Constitution V). Fails if any secret VALUE appears in client assets.
//
//   pnpm check:bundle      (run `pnpm --filter @idiomatic/web build` first)

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env", ".env.local", "apps/web/.env.local"]) {
  dotenv.config({ path: join(root, f) });
}

// Client-served assets only. .next/server is server-side and legitimately holds secrets.
const clientDir = join(root, "apps/web/.next/static");
if (!existsSync(clientDir)) {
  console.error("✗ apps/web/.next/static not found. Build first: pnpm --filter @idiomatic/web build");
  process.exit(1);
}

// Server-only secret env keys whose VALUES must not appear in client assets.
const SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET",
  "SUPABASE_DB_URL",
];
const secrets = SECRET_KEYS.map((k) => ({ key: k, value: process.env[k] }))
  .filter((s) => s.value && s.value.trim().length >= 8);

// Also flag obvious secret-shaped tokens regardless of env (defense in depth).
const PATTERNS = [
  { name: "anthropic key", re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "service_role JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|css|map|json|txt|html)$/.test(entry)) yield p;
  }
}

const findings = [];
let scanned = 0;
for (const file of walk(clientDir)) {
  scanned++;
  const text = readFileSync(file, "utf8");
  for (const s of secrets) {
    if (text.includes(s.value)) findings.push(`${s.key} value leaked in ${rel(file)}`);
  }
  for (const p of PATTERNS) {
    if (p.re.test(text)) findings.push(`possible ${p.name} in ${rel(file)}`);
  }
}

function rel(p) {
  return p.slice(root.length + 1);
}

console.log(`Scanned ${scanned} client asset(s) in apps/web/.next/static.`);
if (findings.length > 0) {
  console.error("✗ Potential secret leakage:");
  for (const f of [...new Set(findings)]) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ No server secrets found in the client bundle.");
