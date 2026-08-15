/**
 * SERVER-ONLY: the direct Postgres connection the lexicon tooling uses, instead of the
 * service-role Supabase client every other module reaches for.
 *
 * Three reasons the PostgREST client is the wrong tool for this one table:
 *
 *   - **It is not owner-scoped** (0010). The Supabase client's whole value here is the owner_id
 *     discipline in `CLAUDE.md`, and there is no owner to scope to — a dictionary entry belongs to
 *     no one. Reaching for it would imply a scoping rule that does not exist.
 *   - **PostgREST caps a response at max-rows** (1,000 by default), and these are 53k-row passes.
 *     `levels.ts` pages around that; here it would be 54 round trips to read one queue.
 *   - **The loader needs a temp table and one transaction** — `create temp table`, `distinct on`,
 *     `analyze` — none of which PostgREST exposes.
 *
 * Same connection string as `scripts/migrate.mjs`: SUPABASE_DB_URL, the DB-password URI, never the
 * service_role API key.
 */
import pg from "pg";

export function hasLexiconDbEnv(): boolean {
  return Boolean((process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL)?.trim());
}

export const LEXICON_DB_ENV_HELP =
  "✗ Missing SUPABASE_DB_URL.\n" +
  "  Set it to the Postgres connection string from\n" +
  "  Supabase → Project Settings → Database → Connection string → URI\n" +
  "  (the same one scripts/migrate.mjs uses — not the service_role API key).";

export async function connectLexiconDb(): Promise<pg.Client> {
  const connectionString = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("SUPABASE_DB_URL not configured");
  // Supabase requires TLS; its cert chain isn't in the local trust store.
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}
