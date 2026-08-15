// Fill in `lexicon.level` for the ~45k dictionary rows the open CEFR lists do not cover.
//
// Phase 1 of docs/2026-08-15-word-autocomplete-suggestions.md. One offline pass over the Message
// Batches API — 50% off list, no latency requirement, embarrassingly parallel. Idempotent: it only
// considers rows with `level is null and level_at is null`, so re-running does nothing and an
// interrupted run resumes.
//
// Usage:
//   pnpm level:lexicon:plan            print the queue and the cost estimate — ZERO LLM calls
//   pnpm level:lexicon --eval          THE GATE: score the model against 300 human-graded rows
//   pnpm level:lexicon                 submit, wait, write
//   pnpm level:lexicon --limit=1000    cap the run (highest-frequency words first)
//   pnpm level:lexicon --no-wait       submit and exit; collect later
//   pnpm level:lexicon --collect       collect every submitted batch that has not been collected
//   pnpm level:lexicon --status        list submitted batches and where they are
//   pnpm level:lexicon --force         clear what the JOB wrote, then re-level (never touches CEFR-J)
//   pnpm level:lexicon --model=claude-haiku-4-5     the ~$3 option; run --eval on both first
//
// Run --eval before the real pass. It levels rows whose CEFR value a human already assigned,
// withholds that value from the model, and reports agreement. If agreement is poor the answer is
// not to abandon the pass but to keep the human value everywhere it exists and ship the model's
// only where there is none — which is what this job does anyway.
//
// Reads ANTHROPIC_API_KEY + SUPABASE_DB_URL from .env.local / .env.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { hasAnthropicEnv } from "../src/lib/llm";
import { hasLexiconDbEnv, connectLexiconDb, LEXICON_DB_ENV_HELP } from "../src/lib/lexicon-db";
import {
  DEFAULT_LEXICON_MODEL,
  LEXICON_BATCH_SIZE,
  LEXICON_LEVELS,
  batchProgress,
  chunk,
  collectBatch,
  listEvalRows,
  listPendingRows,
  resetJobLevels,
  scoreEval,
  submitBatch,
  writeLevels,
  type BatchManifest,
  type LexiconLevel,
  type LexiconQueueRow,
} from "../src/lib/lexicon-levels";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
for (const file of [".env.local", ".env"]) dotenv.config({ path: join(webRoot, file) });

// ── flags ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const evalMode = argv.includes("--eval");
const collectOnly = argv.includes("--collect");
const statusOnly = argv.includes("--status");
const noWait = argv.includes("--no-wait");
const force = argv.includes("--force");
const model = argv.find((a) => a.startsWith("--model="))?.split("=")[1] ?? DEFAULT_LEXICON_MODEL;
const num = (flag: string, fallback?: number): number | undefined => {
  const raw = argv.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`✗ ${flag} must be a positive integer (got ${JSON.stringify(raw)})`);
    process.exit(1);
  }
  return n;
};
const limit = num("--limit");
const sample = num("--sample", 300)!;

// Manifests live beside the lexicon they describe, and are gitignored: they name a batch on
// Anthropic's side and are meaningless in anyone else's checkout.
const manifestDir = join(here, "lexicon", ".batches");

const readManifests = (): BatchManifest[] => {
  mkdirSync(manifestDir, { recursive: true });
  return readdirSync(manifestDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(manifestDir, f), "utf8")) as BatchManifest)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
};
const saveManifest = (m: BatchManifest): void => {
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, `${m.batchId}.json`), JSON.stringify(m, null, 2) + "\n");
};

// Batch pricing = 50% of list. Only for the estimate the plan prints; an unlisted model just
// reports token counts rather than guessing a price.
const BATCH_PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 2.5, out: 12.5 },
  "claude-opus-4-5": { in: 2.5, out: 12.5 },
  "claude-sonnet-5": { in: 1.5, out: 7.5 },
  "claude-haiku-4-5": { in: 0.5, out: 2.5 },
};

// ── env ──────────────────────────────────────────────────────────────────────────────────────
if (!hasLexiconDbEnv()) {
  console.error(LEXICON_DB_ENV_HELP);
  process.exit(1);
}
if (!dryRun && !hasAnthropicEnv()) {
  console.error("✗ Missing ANTHROPIC_API_KEY in .env.local / .env (not needed for --dry-run)");
  process.exit(1);
}

const label = evalMode ? "  --eval" : collectOnly ? "  --collect" : statusOnly ? "  --status" : "";
console.log(`▶ level:lexicon${dryRun ? "  (dry run)" : label}${force ? "  --force" : ""}`);

const db = await connectLexiconDb();

try {
  // ── --status ────────────────────────────────────────────────────────────────────────────────
  if (statusOnly) {
    const manifests = readManifests();
    if (manifests.length === 0) {
      console.log("\n  no batches submitted from this checkout.");
    }
    for (const m of manifests) {
      const p = await batchProgress(m.batchId);
      const done = m.collectedAt ? `collected ${m.collectedAt}` : "NOT collected";
      console.log(
        `  ${m.batchId}  ${m.mode.padEnd(4)} ${m.model.padEnd(18)} ${p.status.padEnd(11)} ` +
          `ok=${p.succeeded} err=${p.errored} running=${p.processing}  ${done}`,
      );
    }
    process.exit(0);
  }

  // ── --collect ───────────────────────────────────────────────────────────────────────────────
  if (collectOnly) {
    const pending = readManifests().filter((m) => !m.collectedAt);
    if (pending.length === 0) {
      console.log("\n✅ nothing to collect — every submitted batch has been collected.");
      process.exit(0);
    }
    for (const m of pending) await finish(m);
    process.exit(0);
  }

  // ── --force ─────────────────────────────────────────────────────────────────────────────────
  // Before the plan is read, so the plan reflects what will actually happen.
  if (force && !evalMode) {
    if (dryRun) {
      console.log(
        "  --force would clear level/level_at on every JOB-levelled row, re-queueing them.",
      );
      console.log("  (dry run: not clearing, so the plan below shows only the CURRENT queue)");
    } else {
      const reset = await resetJobLevels(db);
      console.log(`  cleared ${reset} job-levelled row(s) — they are pending again`);
      console.log(`  (human CEFR values from cefrj/octanove were not touched)`);
    }
  }

  // ── the plan ────────────────────────────────────────────────────────────────────────────────
  const rows: LexiconQueueRow[] = evalMode
    ? await listEvalRows(db, sample)
    : await listPendingRows(db, { limit });

  if (rows.length === 0) {
    console.log("\n✅ nothing to do — every lexicon row has a level or has been attempted.");
    process.exit(0);
  }

  const requests = Math.ceil(rows.length / LEXICON_BATCH_SIZE);
  const promptChars = chunk(rows)
    .slice(0, 20)
    .reduce(
      (n, g) => n + g.reduce((m, r) => m + r.text.length + r.ru.join(", ").length + 12, 0),
      0,
    );
  // ~3.7 chars/token for this mix of Latin and Cyrillic, plus the ~700-token system prompt. An
  // estimate, and labelled as one — a dry run makes zero API calls, including token counting.
  const inTok = requests * (700 + promptChars / Math.min(20, requests) / 3.7);
  const outTok = requests * LEXICON_BATCH_SIZE * 12;
  const price = BATCH_PRICING[model];

  console.log(
    `\n  ${evalMode ? "eval sample" : "queue"}: ${rows.length} row(s) → ${requests} request(s) of ${LEXICON_BATCH_SIZE}`,
  );
  console.log(`  model: ${model}`);
  console.log(
    `  ≈${(inTok / 1e6).toFixed(2)}M input + ${(outTok / 1e6).toFixed(2)}M output tokens` +
      (price
        ? ` ≈ $${((inTok / 1e6) * price.in + (outTok / 1e6) * price.out).toFixed(2)} at batch rates (estimate)`
        : "  (no batch price on file for this model)"),
  );
  if (evalMode)
    console.log(`  scoring against the human CEFR value on each row — nothing is written`);

  if (dryRun) {
    console.log("\n✅ dry run — nothing submitted.");
    process.exit(0);
  }

  // ── submit ──────────────────────────────────────────────────────────────────────────────────
  const manifest = await submitBatch(rows, { model, mode: evalMode ? "eval" : "run" });
  saveManifest(manifest);
  console.log(`\n  submitted ${manifest.batchId} (manifest in scripts/lexicon/.batches/)`);

  if (noWait) {
    console.log(`\n✅ submitted. Collect it later with:  pnpm level:lexicon --collect`);
    process.exit(0);
  }

  await waitFor(manifest.batchId);
  await finish(manifest, rows);
} finally {
  await db.end();
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

/** Poll until the batch ends. Batches usually finish in minutes; the SLA is 24h. */
async function waitFor(batchId: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const p = await batchProgress(batchId);
    const mins = Math.round((Date.now() - started) / 60000);
    process.stdout.write(
      `\r  ${p.status}  ok=${p.succeeded} err=${p.errored} running=${p.processing}  (${mins}m)   `,
    );
    if (p.status === "ended") break;
    // Keep the Postgres connection warm. A full pass can poll for an hour, and Supabase closes
    // idle connections — losing it here would strand results that have already been paid for.
    // (`--collect` recovers from the manifest either way; this just avoids needing it.)
    await db.query("select 1");
    await new Promise((r) => setTimeout(r, 20_000));
  }
  process.stdout.write("\n");
}

/** Collect a batch's results, then either score them (eval) or write them (run). */
async function finish(manifest: BatchManifest, known?: LexiconQueueRow[]): Promise<void> {
  const collected = await collectBatch(manifest);
  console.log(
    `  collected ${manifest.batchId}: ${collected.levels.size} levelled, ` +
      `${collected.unanswered.length} declined, ${collected.failedRequests} request(s) failed`,
  );
  for (const e of collected.errors) console.log(`    ⚠ ${e}`);

  if (manifest.mode === "eval") {
    // The eval's rows are re-read rather than trusted from the manifest when collecting later: the
    // manifest stores keys, and the human level has to come from the table anyway.
    const rows = known ?? (await rowsForKeys(Object.values(manifest.requests).flat()));
    printEval(rows, collected, manifest.model);
  } else {
    const written = await writeLevels(db, collected);
    console.log(`  wrote ${written} level(s); stamped ${collected.unanswered.length} as attempted`);
    const { rows: after } = await db.query<{ level: string | null; n: string }>(
      `select level::text, count(*)::text n from lexicon group by 1 order by 1 nulls last`,
    );
    console.log(
      "\n  lexicon now: " + after.map((r) => `${r.level ?? "unlevelled"} ${r.n}`).join(" · "),
    );
  }

  manifest.collectedAt = new Date().toISOString();
  saveManifest(manifest);
  console.log(`\n✅ done.`);
}

async function rowsForKeys(keys: string[]): Promise<LexiconQueueRow[]> {
  const { rows } = await db.query<LexiconQueueRow>(
    `select key, text, ru, level as known from lexicon where key = any($1::text[])`,
    [keys],
  );
  return rows;
}

function printEval(
  rows: LexiconQueueRow[],
  collected: Awaited<ReturnType<typeof collectBatch>>,
  usedModel: string,
): void {
  const r = scoreEval(rows, collected);
  const pct = (n: number) => (r.answered > 0 ? `${((n / r.answered) * 100).toFixed(0)}%` : "—");

  console.log(`\n  ── ${usedModel} vs CEFR-J / Octanove, ${r.answered} of ${r.n} scored ──`);
  console.log(`  exact        ${String(r.exact).padStart(4)}  ${pct(r.exact)}`);
  console.log(`  within one   ${String(r.withinOne).padStart(4)}  ${pct(r.withinOne)}`);
  console.log(`  declined     ${String(r.omitted).padStart(4)}`);
  console.log(
    `  bias         ${r.bias >= 0 ? "+" : ""}${r.bias.toFixed(2)} level(s) — ` +
      `the model grades ${r.bias > 0.1 ? "HARDER than" : r.bias < -0.1 ? "EASIER than" : "about the same as"} the humans`,
  );

  console.log(`\n  confusion (rows = human, columns = model)`);
  console.log(`        ${LEXICON_LEVELS.map((l) => l.padStart(5)).join("")}`);
  for (const truth of LEXICON_LEVELS) {
    const line = r.confusion.get(truth as LexiconLevel);
    const total = [...(line?.values() ?? [])].reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    console.log(
      `  ${truth}  ` +
        LEXICON_LEVELS.map((p) => String(line?.get(p as LexiconLevel) ?? 0).padStart(5)).join("") +
        `   (n=${total})`,
    );
  }

  // The gate, stated rather than left to interpretation. §11 of the doc: poor agreement does not
  // kill D2, it just means the model's value is only ever used where a human has none — which is
  // already the design, since the queue skips levelled rows.
  const exactPct = r.answered > 0 ? (r.exact / r.answered) * 100 : 0;
  const nearPct = r.answered > 0 ? (r.withinOne / r.answered) * 100 : 0;
  console.log(
    `\n  verdict: ${
      exactPct >= 45 && nearPct >= 85
        ? "GOOD — better than the 39% exact / 83% within-one that frequency alone scored (§4.2). Proceed."
        : exactPct >= 35 && nearPct >= 80
          ? "ADEQUATE — comparable to frequency inference. It beats showing nothing on 85% of rows, but the badge should not be presented as authoritative."
          : "WEAK — worse than frequency inference. Try another model before the full pass."
    }`,
  );
}
