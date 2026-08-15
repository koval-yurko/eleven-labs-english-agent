// Load the built lexicon artifact into Postgres. Phase 0 of
// docs/2026-08-15-word-autocomplete-suggestions.md.
//
// Reads data/lexicon.jsonl.gz (built by build_lexicon.py, committed) and converges the `lexicon`
// table on it: new words inserted, changed words updated, words no longer in the artifact pruned.
// Idempotent — re-running a second time reports zero changes.
//
// Usage:
//   pnpm lexicon:load                apply
//   pnpm lexicon:load:plan           parse + validate + print the plan, touch nothing
//   pnpm lexicon:load --no-prune     leave rows the artifact no longer contains
//   pnpm lexicon:load --file=x.gz    load a different artifact
//
// Requires SUPABASE_DB_URL — the same Postgres connection string scripts/migrate.mjs uses, not the
// service_role API key. `pg` rather than the Supabase JS client because this is bulk DDL+DML in one
// transaction: a temp staging table, one dedupe pass, one prune.

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { hasLexiconDbEnv, connectLexiconDb, LEXICON_DB_ENV_HELP } from "../../src/lib/lexicon-db";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", ".."); // apps/web
for (const file of [".env.local", ".env"]) dotenv.config({ path: join(webRoot, file) });

// ── flags ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const prune = !argv.includes("--no-prune");
const file =
  argv.find((a) => a.startsWith("--file="))?.split("=")[1] ??
  join(here, "data", "lexicon.jsonl.gz");

// One statement per batch. Small enough that a bad row names itself in the error, large enough
// that 53k rows is ~27 round trips rather than 53k.
const BATCH = 2000;

const LEVEL_SOURCES = new Set(["cefrj", "octanove", "job"]);

// The `cefr_level` Postgres enum (0004), which is A1–C2. NOT `CEFR_LEVELS` from @tutor/shared,
// which is A2–C2 — "A1 is headroom; the UI offers A2–C2" (0004), because the level job never
// assigns A1 to a word a learner bothered to add. A dictionary is the other case: CEFR-J grades
// 1,058 of these rows A1 and the ask is explicitly "A1 – C2", so they load. Which of the two
// vocabularies `WordSuggestion.level` speaks is a PHASE 2 decision — see the doc’s §6.
const DB_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
type DbLevel = (typeof DB_LEVELS)[number];

/** One line of the artifact. `key` is deliberately absent — Postgres computes it (see below). */
interface LexiconRow {
  text: string;
  zipf: number;
  ru: string[];
  level: DbLevel | null;
  level_source: string | null;
}

function parse(line: string, lineNo: number): LexiconRow {
  const raw: unknown = JSON.parse(line);
  const fail = (why: string): never => {
    console.error(`✗ ${file}:${lineNo} — ${why}`);
    process.exit(1);
  };
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const row = raw as Record<string, unknown>;

  if (typeof row.text !== "string" || row.text.trim() === "") return fail("missing text");
  if (typeof row.zipf !== "number" || !Number.isFinite(row.zipf)) return fail("missing zipf");
  if (!Array.isArray(row.ru) || row.ru.some((g) => typeof g !== "string"))
    return fail("ru is not string[]");
  if (row.level !== null && !DB_LEVELS.includes(row.level as DbLevel)) {
    return fail(`level ${JSON.stringify(row.level)} is not a CEFR level`);
  }
  // Enforced by a CHECK constraint too; catching it here names the line instead of the batch.
  if (row.level_source !== null && !LEVEL_SOURCES.has(String(row.level_source))) {
    return fail(
      `level_source ${JSON.stringify(row.level_source)} is not one of ${[...LEVEL_SOURCES].join("/")}`,
    );
  }
  if ((row.level === null) !== (row.level_source === null))
    return fail("level and level_source disagree");

  return {
    text: row.text,
    zipf: row.zipf,
    ru: row.ru as string[],
    level: row.level as DbLevel | null,
    level_source: row.level_source as string | null,
  };
}

// ── read ─────────────────────────────────────────────────────────────────────────────────────
console.log(`▶ lexicon:load${dryRun ? "  (dry run)" : ""}${prune ? "" : "  --no-prune"}`);
console.log(`  reading ${file}`);

const rows: LexiconRow[] = [];
const byLevel = new Map<string, number>();
let lineNo = 0;

const lines = createInterface({
  input: createReadStream(file).pipe(createGunzip()),
  crlfDelay: Infinity,
});
for await (const line of lines) {
  lineNo++;
  if (line.trim() === "") continue;
  const row = parse(line, lineNo);
  rows.push(row);
  const bucket = row.level ?? "—";
  byLevel.set(bucket, (byLevel.get(bucket) ?? 0) + 1);
}

if (rows.length === 0) {
  console.error("✗ artifact is empty — run build_lexicon.py first (see README.md)");
  process.exit(1);
}

const leveled = rows.length - (byLevel.get("—") ?? 0);
const spread = DB_LEVELS.map((l) => `${l} ${byLevel.get(l) ?? 0}`).join(" · ");
console.log(
  `  ${rows.length} rows · ${leveled} levelled (${Math.round((leveled / rows.length) * 100)}%)`,
);
console.log(`  ${spread} · unlevelled ${byLevel.get("—") ?? 0}`);

if (dryRun) {
  console.log("\n✅ dry run — artifact is valid, nothing written.");
  process.exit(0);
}

// ── env ──────────────────────────────────────────────────────────────────────────────────────
if (!hasLexiconDbEnv()) {
  console.error(LEXICON_DB_ENV_HELP);
  process.exit(1);
}

const client = await connectLexiconDb();

/** `count(*)::text` as a number. Text, then Number: pg hands back bigint as a string. */
async function count(sql: string): Promise<number> {
  const { rows: counted } = await client.query<{ n: string }>(sql);
  return Number(counted[0]?.n ?? 0);
}

try {
  await client.query("begin");

  // Staging, not a direct upsert: two artifact rows can normalize to ONE key (café / cafe), and a
  // multi-row INSERT ... ON CONFLICT whose own rows collide on the arbiter raises "cannot affect
  // row a second time" — the same trap resolve_words documents in 0007. Staging lets Postgres
  // resolve the collision with DISTINCT ON, using its own key function rather than the build
  // script's Python approximation of it.
  await client.query(`
    create temp table lexicon_stage (
      key          text,
      text         text not null,
      level        cefr_level,
      level_source text,
      zipf         real not null,
      ru           text[] not null
    ) on commit drop
  `);

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await client.query(
      `insert into lexicon_stage (key, text, level, level_source, zipf, ru)
       select lesson_item_norm_key(r->>'text'),
              r->>'text',
              (r->>'level')::cefr_level,
              r->>'level_source',
              (r->>'zipf')::real,
              coalesce(array(select jsonb_array_elements_text(r->'ru')), '{}')
         from jsonb_array_elements($1::jsonb) r`,
      [JSON.stringify(slice)],
    );
    process.stdout.write(`\r  staged ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  process.stdout.write("\n");

  // A headword that normalizes to NULL is punctuation-only; it would violate the PK. None survive
  // the build script's filter, but the loader is the thing that must not fail on a hand-made file.
  const keyless = await count("select count(*)::text as n from lexicon_stage where key is null");
  if (keyless > 0) console.log(`  ⚠ ${keyless} row(s) normalize to no key — skipped`);

  await client.query("create index on lexicon_stage (key)");
  await client.query("analyze lexicon_stage");

  const before = await count("select count(*)::text as n from lexicon");

  // `text` is NOT written here — the trigger derives `key` from it, and passing key explicitly
  // would let the two drift. DISTINCT ON keeps the most frequent spelling of a folded collision.
  const upsert = await client.query(`
    insert into lexicon (text, level, level_source, zipf, ru)
    select distinct on (key) text, level, level_source, zipf, ru
      from lexicon_stage
     where key is not null
     order by key, zipf desc, text
    on conflict (key) do update set
      text         = excluded.text,
      zipf         = excluded.zipf,
      ru           = excluded.ru,
      -- Phase 1's LLM level pass writes level_source='job' straight into this table. A rebuild of
      -- the artifact must not throw that away: take the incoming level only when there is one
      -- (i.e. a human CEFR list vouched for the word), otherwise keep what is already there.
      level        = coalesce(excluded.level, lexicon.level),
      level_source = case when excluded.level is not null then excluded.level_source
                          else lexicon.level_source end
  `);

  let pruned = 0;
  if (prune) {
    const gone = await client.query(
      "delete from lexicon l where not exists (select 1 from lexicon_stage s where s.key = l.key)",
    );
    pruned = gone.rowCount ?? 0;
  }

  const after = await count("select count(*)::text as n from lexicon");
  await client.query("commit");

  // Not optional, and not just hygiene. A freshly bulk-loaded table has no statistics, and without
  // them the planner costs `key like 'ubi%'` as if it matched a fifth of the table — so it walks
  // lexicon_zipf_idx to satisfy the ORDER BY and filters 53,536 rows away per query (measured: 30 ms
  // and 46,159 buffers, versus 0.07 ms and 3 once analyzed). Autovacuum gets there eventually; the
  // window in between is exactly when someone benchmarks the new route and concludes it is slow.
  await client.query("analyze lexicon");

  console.log(`\n✅ lexicon: ${before} → ${after} rows`);
  console.log(`   ${upsert.rowCount} inserted or updated${prune ? `, ${pruned} pruned` : ""}`);
} catch (err) {
  await client.query("rollback");
  console.error(
    `\n✗ load failed — rolled back:\n  ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  await client.end();
}
