// Hardening check (T054 / T037): assert Row-Level Security is enabled and policies
// exist on every owned table. Static DB-state check (does not exercise auth.jwt()).
// Requires SUPABASE_DB_URL.
//
//   pnpm rls:smoke

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import pg from "pg";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["apps/web/.env.local", ".env.local", ".env"]) {
  dotenv.config({ path: join(root, f) });
}

const connectionString = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error("✗ Missing SUPABASE_DB_URL (see scripts/migrate.mjs).");
  process.exit(1);
}

const TABLES = ["lessons", "source_items", "lesson_audio"];
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

let failed = false;
try {
  await client.connect();
  for (const table of TABLES) {
    const { rows: rls } = await client.query(
      "select relrowsecurity from pg_class where relname = $1 and relnamespace = 'public'::regnamespace",
      [table],
    );
    const enabled = rls[0]?.relrowsecurity === true;

    const { rows: pol } = await client.query(
      "select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = $1",
      [table],
    );
    const policies = pol[0]?.n ?? 0;

    const ok = enabled && policies > 0;
    if (!ok) failed = true;
    console.log(
      `${ok ? "✓" : "✗"} ${table}: RLS ${enabled ? "enabled" : "DISABLED"}, ${policies} policy(ies)`,
    );
  }
} catch (err) {
  console.error(`✗ RLS smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  await client.end();
}

if (failed) {
  console.error("\n✗ RLS is not fully configured — owned tables must have RLS enabled + ≥1 policy.");
  process.exit(1);
}
console.log("\n✅ RLS enabled with policies on all owned tables.");
