/**
 * SERVER-ONLY: the CEFR level job — fills in `words.level` by asking the LLM.
 * See docs/2026-07-16-level-assignment-background-job.md.
 *
 * Called by `after()` on the item-write path (fast) and by `pnpm level:items` (the sweep that
 * backfills and catches what the fast path dropped). `level` is nullable forever and the page
 * renders "unleveled" deliberately, so this job may be partial, slow, and fallible — which is why
 * there is no retry/backoff and no scheduler.
 */
import { z } from "zod";
import { getChatModel } from "./llm";
import { getServiceSupabase } from "./supabase/server";
import { CEFR_LEVELS, type CefrLevel, type ItemKind } from "@tutor/shared/words/types";
import { LEVEL_SYSTEM_PROMPT, buildLevelPrompt } from "./levels-prompt";

/** Items per LLM call — a blast radius, not a token limit: one failed call costs this many items. */
export const LEVEL_BATCH_SIZE = 25;

/** Cap for the `after()` path so one request never runs a whole backfill. The sweep does the rest. */
export const LEVEL_AFTER_LIMIT = 50;

/** PostgREST caps a response at the project's max-rows (1000 by default) — page past it. */
const PAGE_SIZE = 1000;

export interface PendingItem {
  owner_id: string;
  /** The `words` row to stamp — the queue's rows ARE words since 0007. */
  word_id: string;
  norm_key: string;
  text: string;
  kind: ItemKind;
  first_added_at: string;
}

export interface LevelRunResult {
  pending: number;
  leveled: number;
  /** Attempted but left unleveled — the model had no answer. Never re-asked. */
  unanswered: number;
  /** Nothing was stamped for these; the next sweep retries them. */
  failedBatches: number;
  batches: number;
  /** One per failed batch. Carried out so the CLI can print the cause; `after()` drops them. */
  errors: string[];
}

export interface LevelOptions {
  limit?: number;
  onBatch?: (done: number, total: number) => void;
  /** Pre-fetched queue, so the CLI's plan and its run are the same read. */
  items?: PendingItem[];
}

/** `level` is a bare string, not a z.enum: one out-of-range value would fail the whole batch's
 *  parse. Validated per item below instead. */
const BatchSchema = z.object({
  items: z.array(z.object({ index: z.number().int(), level: z.string() })),
});

/** A2 is the floor `CEFR_LEVELS` offers, so an A1 row would render a chip no filter can select. */
function normalizeLevel(raw: string): CefrLevel | null {
  const v = raw.trim().toUpperCase();
  if (v === "A1") return "A2";
  return (CEFR_LEVELS as readonly string[]).includes(v) ? (v as CefrLevel) : null;
}

/**
 * Clear the processed flag so the sweep re-levels — what `--force` means.
 *
 * A reset rather than "read every item instead of the queue": reading around the flag means a force
 * run never consumes its queue, so `--force --limit=N` re-levels the same N forever and an
 * interrupted run restarts from zero.
 */
export async function resetLevelFlags(ownerId: string | null): Promise<number> {
  let q = getServiceSupabase()
    .from("words")
    .update({ level_at: null, updated_at: new Date().toISOString() })
    .not("level_at", "is", null);
  if (ownerId) q = q.eq("owner_id", ownerId);

  const { data, error } = await q.select("id");
  if (error) throw new Error(`resetLevelFlags: ${error.message}`);
  return data?.length ?? 0;
}

/**
 * The queue — one row per item never attempted, so callers get deduplication for free.
 *
 * Newest first is load-bearing: `after()` takes only the first LEVEL_AFTER_LIMIT, and the item the
 * learner just added has to be in that window.
 */
export async function listPendingItems(
  ownerId: string | null,
  opts: Pick<LevelOptions, "limit"> = {},
): Promise<PendingItem[]> {
  const page = (from: number, to: number) => {
    let q = getServiceSupabase()
      .from("owner_items_pending_level")
      .select("owner_id, word_id, norm_key, text, kind, first_added_at");
    if (ownerId) q = q.eq("owner_id", ownerId);
    return q
      .order("first_added_at", { ascending: false })
      .order("norm_key", { ascending: true })
      .range(from, to);
  };

  // Unpaginated, a backfill past max-rows would report "done" having skipped the rest.
  const out: PendingItem[] = [];
  for (;;) {
    const want = opts.limit ? Math.min(PAGE_SIZE, opts.limit - out.length) : PAGE_SIZE;
    const { data, error } = await page(out.length, out.length + want - 1);
    if (error) throw new Error(`listPendingItems: ${error.message}`);
    const rows = (data as PendingItem[] | null) ?? [];
    out.push(...rows);
    if (rows.length < want) break;
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * One LLM call → index → level. An item the model omitted is absent from the map (a semantic miss).
 * Throws only on a transport failure; that distinction is this function's contract.
 */
async function classifyBatch(items: PendingItem[]): Promise<Map<number, CefrLevel>> {
  // The shared 1024 default is sized for a chat turn; a 25-item reply can hit it, and truncation
  // throws on parse every time for that batch — a permanent failure dressed as a transient one.
  const model = getChatModel({ maxTokens: 4096 }).withStructuredOutput(BatchSchema, {
    name: "cefr_levels",
  });

  const res = await model.invoke([
    { role: "system", content: LEVEL_SYSTEM_PROMPT },
    { role: "user", content: buildLevelPrompt(items) },
  ]);

  const out = new Map<number, CefrLevel>();
  for (const entry of res.items) {
    // Keyed by index, never by echoed text: a reordered or reworded answer would silently
    // mis-assign levels across the batch.
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= items.length) continue;
    const level = normalizeLevel(entry.level);
    if (level) out.set(entry.index, level);
  }
  return out;
}

/**
 * Every item is stamped with `level_at` whether or not it got a level — that's what makes
 * "looked, no answer" terminal.
 *
 * The answered/unanswered split is load-bearing: unanswered rows must write `level_at` and NOT
 * `level`, because under `--force` the item may already hold a good level, and writing null over it
 * would also stamp it as done — so no sweep would ever re-derive it.
 *
 * UPDATEs, not upserts (0007): the word row always exists — this job levels the collection, it does
 * not populate it — and `words.text` is `not null`, so an upsert without a `text` would fail on the
 * INSERT branch PostgREST always builds. Answered rows are grouped by level because one UPDATE
 * carries one value: at most CEFR_LEVELS.length statements per batch, plus one for the unanswered.
 * `id` is the primary key and comes from the queue this run read, so no owner filter is needed.
 */
async function writeLevels(items: PendingItem[], levels: Map<number, CefrLevel>): Promise<void> {
  const now = new Date().toISOString();
  const db = getServiceSupabase();

  const byLevel = new Map<CefrLevel, string[]>();
  const unanswered: string[] = [];
  items.forEach((it, i) => {
    const level = levels.get(i);
    if (level === undefined) {
      unanswered.push(it.word_id);
      return;
    }
    const ids = byLevel.get(level) ?? [];
    ids.push(it.word_id);
    byLevel.set(level, ids);
  });

  for (const [level, ids] of byLevel) {
    const { error } = await db
      .from("words")
      .update({ level, level_source: "job", level_at: now, updated_at: now })
      .in("id", ids);
    if (error) throw new Error(`writeLevels: ${error.message}`);
  }

  if (unanswered.length > 0) {
    const { error } = await db
      .from("words")
      .update({ level_at: now, updated_at: now })
      .in("id", unanswered);
    if (error) throw new Error(`writeLevels: ${error.message}`);
  }
}

/**
 * Level every item not yet attempted, for one owner or all of them.
 *
 * Idempotent across time — it only considers `level_at is null` — but not across concurrency: two
 * runs starting together both classify the same items, costing two calls for one result. They
 * converge (last write wins), so it's a cost, not a bug, and not worth a lock at this scale.
 *
 * A failing batch is counted; a failure to read the queue throws (that's a bug, not a transient).
 */
export async function levelItems(
  ownerId: string | null,
  opts: LevelOptions = {},
): Promise<LevelRunResult> {
  const pending = opts.items ?? (await listPendingItems(ownerId, opts));
  const result: LevelRunResult = {
    pending: pending.length,
    leveled: 0,
    unanswered: 0,
    failedBatches: 0,
    batches: 0,
    errors: [],
  };

  for (let i = 0; i < pending.length; i += LEVEL_BATCH_SIZE) {
    const batch = pending.slice(i, i + LEVEL_BATCH_SIZE);
    result.batches++;

    let levels: Map<number, CefrLevel>;
    try {
      levels = await classifyBatch(batch);
    } catch (e) {
      // Transport: nothing was learned, so nothing is stamped and the next sweep retries. (A
      // semantic miss is the opposite — writeLevels stamps it and it is never asked about again.
      // Collapsing the two defeats the flag.) Re-running the sweep is the retry; batches are
      // independent, so one failure doesn't abort the run.
      result.failedBatches++;
      result.errors.push(`classify: ${e instanceof Error ? e.message : String(e)}`);
      opts.onBatch?.(Math.min(i + LEVEL_BATCH_SIZE, pending.length), pending.length);
      continue;
    }

    try {
      await writeLevels(batch, levels);
      result.leveled += levels.size;
      result.unanswered += batch.length - levels.size;
    } catch (e) {
      // Distinct from transport: these levels were produced and paid for, and are being discarded.
      result.failedBatches++;
      result.errors.push(
        `write (${levels.size} level(s) classified but NOT saved — they will be re-classified and ` +
          `re-billed next run): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    opts.onBatch?.(Math.min(i + LEVEL_BATCH_SIZE, pending.length), pending.length);
  }
  return result;
}
