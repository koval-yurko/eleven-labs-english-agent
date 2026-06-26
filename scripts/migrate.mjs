// Minimal forward-only migration runner for Supabase (Cloud or local Postgres).
//
// Applies supabase/migrations/*.sql in lexical order, each once, tracked in a
// `schema_migrations` table so re-running is safe and idempotent.
//
// Requires SUPABASE_DB_URL — the Postgres connection string (with the DB password),
// NOT the service_role API key. Get it from:
//   Supabase → Project Settings → Database → Connection string → "URI"
// If your network is IPv4-only and the direct host won't connect, use the
// "Session pooler" connection string instead (port 5432).
//
// Usage:
//   pnpm db:migrate           apply pending migrations
//   pnpm db:migrate:status    list applied vs pending (no changes)

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import pg from "pg";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load env from the usual places (first definition wins; process env always wins).
for (const file of [".env.local", ".env"]) {
  dotenv.config({ path: join(root, file) });
}

const statusOnly = process.argv.includes("--status");
const connectionString = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "✗ Missing SUPABASE_DB_URL.\n" +
      "  Set it to the Postgres connection string from\n" +
      "  Supabase → Project Settings → Database → Connection string → URI\n" +
      "  (this is the DB password connection — not the service_role API key).",
  );
  process.exit(1);
}

const migrationsDir = join(root, "supabase", "migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const client = new pg.Client({
  connectionString,
  // Supabase requires TLS; its cert chain isn't in the local trust store.
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();

  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await client.query("select name from schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  if (statusOnly) {
    console.log("Migration status:");
    for (const file of files) {
      console.log(`  ${applied.has(file) ? "✓ applied" : "• pending"}  ${file}`);
    }
    process.exit(0);
  }

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`• skip    ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    process.stdout.write(`▶ apply   ${file} ... `);
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations(name) values($1)", [file]);
      await client.query("commit");
      console.log("done");
      ran++;
    } catch (err) {
      await client.query("rollback");
      console.error(`\n✗ ${file} failed — rolled back:\n  ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`\n✅ ${ran} applied, ${files.length - ran} already up to date.`);
} finally {
  await client.end();
}
