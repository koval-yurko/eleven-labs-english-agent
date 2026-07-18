// Enrich vocabulary words with translations, forms, and example sentences (words.details).
//
// The sweep half of the word-details job (docs/2026-07-18-word-details-enrichment-job.md): backfills
// existing words and catches anything the `after()` fast path dropped — which is what lets that fast
// path fail silently. Idempotent: it only considers words with `details_at is null`, so re-running
// does nothing and an interrupted run resumes where it stopped.
//
// Usage:
//   pnpm enrich:words                    enrich every un-attempted word, all owners
//   pnpm enrich:words:plan               print the plan, make ZERO LLM calls
//   pnpm enrich:words --owner=<sub>      just this Auth0 sub
//   pnpm enrich:words --limit=100        cap the run
//   pnpm enrich:words --force            clear the flag, then re-enrich everything (after a change)
//   pnpm enrich:words --force --stale    re-enrich ONLY rows built by an older schema version
//   pnpm enrich:words --force --limit=50 … in resumable chunks: re-run to take the next 50
//
// Reads ANTHROPIC_API_KEY + NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from
// .env.local / .env. This job GENERATES learner-facing content, so it defaults to the strong app
// model; set ANTHROPIC_MODEL to tune cost only if you have checked the quality.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { hasAnthropicEnv } from "../src/lib/llm";
import { hasSupabaseEnv } from "../src/lib/supabase/server";
import {
  listPendingWords,
  enrichWords,
  resetDetailsFlags,
  resetStaleDetailsFlags,
  DETAILS_BATCH_SIZE,
} from "../src/lib/word-details";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// .env.local wins, matching scripts/migrate.mjs. Imports are hoisted above this, which is safe only
// because everything above reads env at call time rather than at module scope.
for (const file of [".env.local", ".env"]) dotenv.config({ path: join(root, file) });

// ── flags ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const stale = argv.includes("--stale");
const owner = argv.find((a) => a.startsWith("--owner="))?.split("=")[1] ?? null;
const limitArg = argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const limit = limitArg ? Number(limitArg) : undefined;

if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  console.error(`✗ --limit must be a positive integer (got ${JSON.stringify(limitArg)})`);
  process.exit(1);
}
if (stale && !force) {
  console.error("✗ --stale only applies with --force (it selects which rows --force re-queues)");
  process.exit(1);
}

// ── env ──────────────────────────────────────────────────────────────────────────────────────
if (!hasSupabaseEnv()) {
  console.error("✗ Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local / .env");
  process.exit(1);
}
if (!dryRun && !hasAnthropicEnv()) {
  console.error("✗ Missing ANTHROPIC_API_KEY in .env.local / .env (not needed for --dry-run)");
  process.exit(1);
}

console.log(
  `▶ enrich:words${dryRun ? "  (dry run)" : ""}${force ? (stale ? "  --force --stale" : "  --force") : ""}${owner ? `  owner=${owner}` : ""}`,
);

// ── force: clear the flag, then fall through to an ordinary sweep ─────────────────────────────
// Before the plan is read, so the plan reflects what will actually happen. A dry run changes nothing.
if (force) {
  const what = stale ? "rows built by an older schema version" : "every already-attempted word";
  if (dryRun) {
    console.log(`  --force would clear details_at on ${what}, re-queueing them.`);
    console.log("  (dry run: not clearing, so the plan below shows only the CURRENT queue)");
  } else {
    const reset = stale ? await resetStaleDetailsFlags(owner) : await resetDetailsFlags(owner);
    console.log(`  cleared details_at on ${reset} row(s) — they are pending again`);
  }
}

// ── plan ─────────────────────────────────────────────────────────────────────────────────────
const pending = await listPendingWords(owner, { limit });

if (pending.length === 0) {
  console.log("\n✅ nothing to do — every word has already been attempted.");
  process.exit(0);
}

const byOwner = new Map<string, typeof pending>();
for (const item of pending) {
  const list = byOwner.get(item.owner_id) ?? [];
  list.push(item);
  byOwner.set(item.owner_id, list);
}
const byKind = pending.reduce<Record<string, number>>((acc, i) => {
  acc[i.kind] = (acc[i.kind] ?? 0) + 1;
  return acc;
}, {});

const batches = Math.ceil(pending.length / DETAILS_BATCH_SIZE);
console.log(
  `  ${pending.length} word(s) across ${byOwner.size} owner(s) → ${batches} LLM call(s) of ≤${DETAILS_BATCH_SIZE}`,
);
console.log(`  ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ")}`);
for (const [ownerId, items] of byOwner) {
  const sample = items.slice(0, 3).map((i) => i.text);
  const more = items.length > 3 ? `, +${items.length - 3} more` : "";
  console.log(`  · ${ownerId}  ${items.length}  (${sample.join(", ")}${more})`);
}

if (dryRun) {
  console.log(`\n${pending.length} word(s) would be enriched. Re-run without --dry-run to apply.`);
  process.exit(0);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
// The planned queue is handed to the run, so the plan can't disagree with what executes.
console.log("");
const result = await enrichWords(owner, {
  items: pending,
  onBatch: (done, total) => console.log(`  … ${done}/${total}`),
});

console.log(
  `\n✅ ${result.enriched} enriched, ${result.unanswered} left un-enriched (model had no answer — ` +
    `these are NOT retried), ${result.batches} batch(es).`,
);
if (result.failedBatches > 0) {
  // Print the cause: without it, a transient "529 Overloaded" and a real bug read identically.
  console.error(`\n⚠ ${result.failedBatches} batch(es) failed — those words were NOT stamped and`);
  console.error("  are still pending. Re-run to retry them. Cause:");
  for (const message of result.errors) console.error(`   · ${message.slice(0, 300)}`);
  process.exit(1);
}
