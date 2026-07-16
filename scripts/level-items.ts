// Assign CEFR levels (A2–C2) to vocabulary items that have never been levelled.
//
// The sweep half of the level job (docs/2026-07-16-level-assignment-background-job.md): backfills
// existing items and catches anything the `after()` fast path dropped — which is what lets that
// fast path fail silently. Idempotent: it only considers items with `level_at is null`, so
// re-running does nothing and an interrupted run resumes where it stopped.
//
// Usage:
//   pnpm level:items                  level every un-attempted item, all owners
//   pnpm level:items:plan             print the plan, make ZERO LLM calls
//   pnpm level:items --owner=<sub>    just this Auth0 sub
//   pnpm level:items --limit=100      cap the run
//   pnpm level:items --force          clear the flag, then re-level everything (after a prompt change)
//   pnpm level:items --force --limit=200   … in resumable chunks: re-run to take the next 200
//
// Reads ANTHROPIC_API_KEY + NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from
// .env.local / .env. Set ANTHROPIC_MODEL to pick a cheaper model — the accuracy spread on this
// task is a few points (see the doc's Decision 2), so Opus is overkill.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { hasAnthropicEnv } from "../src/lib/llm";
import { hasSupabaseEnv } from "../src/lib/supabase/server";
import { listPendingItems, levelItems, resetLevelFlags, LEVEL_BATCH_SIZE } from "../src/lib/levels";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// .env.local wins, matching scripts/migrate.mjs (sync-agents.ts loads these in the opposite order).
// Imports are hoisted above this, which is safe only because everything above reads env at call
// time rather than at module scope.
for (const file of [".env.local", ".env"]) dotenv.config({ path: join(root, file) });

// ── flags ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const owner = argv.find((a) => a.startsWith("--owner="))?.split("=")[1] ?? null;
const limitArg = argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const limit = limitArg ? Number(limitArg) : undefined;

if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  console.error(`✗ --limit must be a positive integer (got ${JSON.stringify(limitArg)})`);
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

console.log(`▶ level:items${dryRun ? "  (dry run)" : ""}${force ? "  --force" : ""}${owner ? `  owner=${owner}` : ""}`);

// ── force: clear the flag, then fall through to an ordinary sweep ─────────────────────────────
// Before the plan is read, so the plan reflects what will actually happen. A dry run must change
// nothing, so it reports the reset instead of doing it.
if (force) {
  if (dryRun) {
    console.log("  --force would clear level_at on every already-attempted item, re-queueing them.");
    console.log("  (dry run: not clearing, so the plan below shows only the CURRENT queue)");
  } else {
    const reset = await resetLevelFlags(owner);
    console.log(`  cleared level_at on ${reset} item(s) — they are pending again`);
  }
}

// ── plan ─────────────────────────────────────────────────────────────────────────────────────
const pending = await listPendingItems(owner, { limit });

if (pending.length === 0) {
  console.log("\n✅ nothing to do — every item has already been attempted.");
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

const batches = Math.ceil(pending.length / LEVEL_BATCH_SIZE);
console.log(
  `  ${pending.length} item(s) across ${byOwner.size} owner(s) → ${batches} LLM call(s) of ≤${LEVEL_BATCH_SIZE}`,
);
console.log(`  ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ")}`);
for (const [ownerId, items] of byOwner) {
  const sample = items.slice(0, 3).map((i) => i.text);
  const more = items.length > 3 ? `, +${items.length - 3} more` : "";
  console.log(`  · ${ownerId}  ${items.length}  (${sample.join(", ")}${more})`);
}

if (dryRun) {
  console.log(`\n${pending.length} item(s) would be levelled. Re-run without --dry-run to apply.`);
  process.exit(0);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
// The planned queue is handed to the run, so the plan can't disagree with what executes.
console.log("");
const result = await levelItems(owner, {
  items: pending,
  onBatch: (done, total) => console.log(`  … ${done}/${total}`),
});

console.log(
  `\n✅ ${result.leveled} levelled, ${result.unanswered} left unlevelled (model had no answer — ` +
    `these are NOT retried), ${result.batches} batch(es).`,
);
if (result.failedBatches > 0) {
  // Print the cause: without it, a transient "529 Overloaded" and a real bug read identically.
  console.error(`\n⚠ ${result.failedBatches} batch(es) failed — those items were NOT stamped and`);
  console.error("  are still pending. Re-run to retry them. Cause:");
  for (const message of result.errors) console.error(`   · ${message.slice(0, 300)}`);
  process.exit(1);
}
