/**
 * SERVER-ONLY: the word-details enrichment job — fills in `words.details` by asking the LLM for a
 * rich per-word payload (Russian translations, part of speech, the word family's other forms with
 * their translations, and example sentences).
 * See docs/2026-07-18-word-details-enrichment-job.md.
 *
 * This is the level job (src/lib/levels.ts) a second time, on the same machinery: a work-queue view,
 * an "attempted" flag (`details_at`), an `after()` fast path plus a `pnpm enrich:words` sweep, and
 * the transport-vs-semantic failure split. It differs in three places the payload's SIZE forces:
 *   - Batch size is small (an enrichment answer is a large object, not a two-field level), so a big
 *     batch would blow the token cap and truncation becomes silent data loss.
 *   - The model is the app default (strong): this GENERATES content a learner reads, where a wrong
 *     translation or unnatural sentence is visible in a way an off-by-one CEFR chip is not.
 *   - Each answered word writes its own distinct payload (one UPDATE per word), where the level job
 *     could group many items under one level value.
 *
 * `details` is nullable forever and the page renders the un-enriched state deliberately, so this job
 * may be partial, slow, and fallible — hence no retry/backoff and no scheduler.
 */
import { z } from "zod";
import { getChatModel } from "./llm";
import { getServiceSupabase } from "./supabase/server";
import type { ItemKind, WordDetails } from "@tutor/shared/words/types";
import { DETAILS_SYSTEM_PROMPT, buildDetailsPrompt } from "./word-details-prompt";

/** The schema/prompt version stamped onto every enriched row, so `--force --stale` can re-run only
 *  rows built by an older version instead of re-billing the whole collection. Bump on a shape or
 *  prompt change that should invalidate existing payloads. */
export const CURRENT_DETAILS_VERSION = 1;

/**
 * Words per LLM call. Small on purpose: each answer is a full WordDetails object (~300–500 output
 * tokens, Cyrillic-heavy JSON), so a large batch would exceed the token cap and the failure mode is
 * a TRUNCATED response — which parses as "the model dropped the last few words", i.e. silent loss.
 * Four leaves headroom under the 8192 cap below. See the doc's Decision 3.
 */
export const DETAILS_BATCH_SIZE = 4;

/** maxTokens for the batch call — wide enough for DETAILS_BATCH_SIZE full payloads without clipping
 *  the last one. (getChatModel defaults to 1024, sized for a chat turn.) */
const DETAILS_MAX_TOKENS = 8192;

/**
 * Cap for the `after()` path so one write never runs a whole backfill. Smaller than the level job's
 * 50 because each item here is a full strong-model generation (not a shared batch entry), so 20 is
 * already several sequential calls after an offline flush. The uncapped sweep takes the rest.
 */
export const DETAILS_AFTER_LIMIT = 20;

/** PostgREST caps a response at the project's max-rows (1000 by default) — page past it. */
const PAGE_SIZE = 1000;

/** Safety bounds on a generative payload — a runaway word can't bloat the row or the page. The
 *  prompt already asks for "up to ~5 forms, ~4 examples"; these are the hard ceiling. */
const MAX_TRANSLATIONS = 6;
const MAX_FORMS = 8;
const MAX_EXAMPLES = 6;

export interface PendingWord {
  owner_id: string;
  word_id: string;
  norm_key: string;
  text: string;
  kind: ItemKind;
  first_added_at: string;
}

export interface EnrichRunResult {
  pending: number;
  enriched: number;
  /** Attempted but left un-enriched — the model had no usable answer. Never re-asked. */
  unanswered: number;
  /** Nothing was stamped for these; the next sweep retries them. */
  failedBatches: number;
  batches: number;
  /** One per failed batch. Carried out so the CLI can print the cause; `after()` drops them. */
  errors: string[];
}

export interface EnrichOptions {
  limit?: number;
  onBatch?: (done: number, total: number) => void;
  /** Pre-fetched queue, so the CLI's plan and its run are the same read. */
  items?: PendingWord[];
}

/**
 * Permissive on purpose: nested optional fields and bare strings, so one lazily-formatted word can't
 * fail the whole batch's structured-output parse (the level job's "bare string, not z.enum" lesson,
 * one level up). Content is trimmed / capped / validated per word in `normalizeDetails` afterwards.
 */
const DetailsShape = z.object({
  pos: z.string(),
  translations_ru: z.array(z.string()),
  forms: z.array(
    z.object({
      text: z.string(),
      pos: z.string(),
      translations_ru: z.array(z.string()),
    }),
  ),
  examples: z.array(
    z.object({
      text: z.string(),
      form: z.string().optional(),
      translation_ru: z.string().optional(),
    }),
  ),
});

const BatchSchema = z.object({
  items: z.array(z.object({ index: z.number().int(), details: DetailsShape })),
});

const cleanList = (xs: string[], max: number): string[] =>
  Array.from(new Set(xs.map((s) => s.trim()).filter(Boolean))).slice(0, max);

/**
 * Trim, dedupe, and cap a raw payload; return null when it carries nothing usable so the caller
 * treats it as a semantic miss (stamp the flag, write no `details`) rather than storing an empty
 * shell. "Usable" = at least one translation or one example — a valid enrichment always has one.
 */
function normalizeDetails(raw: z.infer<typeof DetailsShape>): WordDetails | null {
  const translations_ru = cleanList(raw.translations_ru, MAX_TRANSLATIONS);

  const forms = raw.forms
    .map((f) => ({
      text: f.text.trim(),
      pos: f.pos.trim(),
      translations_ru: cleanList(f.translations_ru, MAX_TRANSLATIONS),
    }))
    .filter((f) => f.text.length > 0)
    .slice(0, MAX_FORMS);

  const examples = raw.examples
    .map((e) => ({
      text: e.text.trim(),
      form: e.form?.trim() || undefined,
      translation_ru: e.translation_ru?.trim() || undefined,
    }))
    .filter((e) => e.text.length > 0)
    .slice(0, MAX_EXAMPLES);

  if (translations_ru.length === 0 && examples.length === 0) return null;
  return { pos: raw.pos.trim(), translations_ru, forms, examples };
}

/**
 * Clear the processed flag so the sweep re-enriches — what `--force` means. A reset rather than
 * "read every word instead of the queue", for the same reason the level job resets: reading around
 * the flag means a force run never consumes its queue. See src/lib/levels.ts:resetLevelFlags.
 */
export async function resetDetailsFlags(ownerId: string | null): Promise<number> {
  let q = getServiceSupabase()
    .from("words")
    .update({ details_at: null, updated_at: new Date().toISOString() })
    .not("details_at", "is", null);
  if (ownerId) q = q.eq("owner_id", ownerId);

  const { data, error } = await q.select("id");
  if (error) throw new Error(`resetDetailsFlags: ${error.message}`);
  return data?.length ?? 0;
}

/**
 * Re-queue only rows enriched by an OLDER schema version — `--force --stale`. Leaves current-version
 * rows (and rows that were attempted but got no payload) alone, so a schema bump re-bills only what
 * actually needs re-running.
 */
export async function resetStaleDetailsFlags(ownerId: string | null): Promise<number> {
  let q = getServiceSupabase()
    .from("words")
    .update({ details_at: null, updated_at: new Date().toISOString() })
    .not("details", "is", null)
    .lt("details_version", CURRENT_DETAILS_VERSION);
  if (ownerId) q = q.eq("owner_id", ownerId);

  const { data, error } = await q.select("id");
  if (error) throw new Error(`resetStaleDetailsFlags: ${error.message}`);
  return data?.length ?? 0;
}

/**
 * The queue — one row per word never attempted, newest first (so the `after()` window contains the
 * word the learner just added). Paginated: an unbounded backfill past max-rows would report "done"
 * having skipped the rest.
 */
export async function listPendingWords(
  ownerId: string | null,
  opts: Pick<EnrichOptions, "limit"> = {},
): Promise<PendingWord[]> {
  const page = (from: number, to: number) => {
    let q = getServiceSupabase()
      .from("owner_words_pending_details")
      .select("owner_id, word_id, norm_key, text, kind, first_added_at");
    if (ownerId) q = q.eq("owner_id", ownerId);
    return q
      .order("first_added_at", { ascending: false })
      .order("norm_key", { ascending: true })
      .range(from, to);
  };

  const out: PendingWord[] = [];
  for (;;) {
    const want = opts.limit ? Math.min(PAGE_SIZE, opts.limit - out.length) : PAGE_SIZE;
    const { data, error } = await page(out.length, out.length + want - 1);
    if (error) throw new Error(`listPendingWords: ${error.message}`);
    const rows = (data as PendingWord[] | null) ?? [];
    out.push(...rows);
    if (rows.length < want) break;
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * One LLM call → index → normalized details. A word the model omitted, or one that normalized to
 * nothing usable, is absent from the map (a semantic miss). Throws only on a transport failure; that
 * distinction is this function's contract, exactly as in the level job.
 */
async function enrichBatch(items: PendingWord[]): Promise<Map<number, WordDetails>> {
  const model = getChatModel({ maxTokens: DETAILS_MAX_TOKENS }).withStructuredOutput(BatchSchema, {
    name: "word_details",
  });

  const res = await model.invoke([
    { role: "system", content: DETAILS_SYSTEM_PROMPT },
    { role: "user", content: buildDetailsPrompt(items) },
  ]);

  const out = new Map<number, WordDetails>();
  for (const entry of res.items) {
    // Keyed by index, never by echoed text: a reordered or reworded answer would silently
    // mis-assign payloads across the batch.
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= items.length) continue;
    const details = normalizeDetails(entry.details);
    if (details) out.set(entry.index, details);
  }
  return out;
}

/**
 * Stamp every word with `details_at` whether or not it got a payload — that's what makes "looked, no
 * answer" terminal. Answered words additionally write `details` + `details_version`; unanswered
 * words write `details_at` ONLY, never nulling a `details` a `--force` run may not replace (the
 * clobber bug the level job's review caught).
 *
 * One UPDATE per answered word — each carries a distinct jsonb payload, so they can't be grouped the
 * way the level job grouped ids by shared level. `id` is the primary key from the queue this run
 * read, so no owner filter is needed.
 */
async function writeDetails(items: PendingWord[], details: Map<number, WordDetails>): Promise<void> {
  const now = new Date().toISOString();
  const db = getServiceSupabase();

  const unanswered: string[] = [];
  for (const [i, item] of items.entries()) {
    const payload = details.get(i);
    if (payload === undefined) {
      unanswered.push(item.word_id);
      continue;
    }
    const { error } = await db
      .from("words")
      .update({
        details: payload,
        details_version: CURRENT_DETAILS_VERSION,
        details_at: now,
        updated_at: now,
      })
      .eq("id", item.word_id);
    if (error) throw new Error(`writeDetails: ${error.message}`);
  }

  if (unanswered.length > 0) {
    const { error } = await db
      .from("words")
      .update({ details_at: now, updated_at: now })
      .in("id", unanswered);
    if (error) throw new Error(`writeDetails: ${error.message}`);
  }
}

/**
 * Enrich every word not yet attempted, for one owner or all of them.
 *
 * Idempotent across time (only `details_at is null`), but not across concurrency: two runs starting
 * together both enrich the same words, costing two calls for one result. They converge (last write
 * wins), so it's a cost, not a bug, and not worth a lock at this scale.
 *
 * A failing batch is counted; a failure to read the queue throws (that's a bug, not a transient).
 */
export async function enrichWords(
  ownerId: string | null,
  opts: EnrichOptions = {},
): Promise<EnrichRunResult> {
  const pending = opts.items ?? (await listPendingWords(ownerId, opts));
  const result: EnrichRunResult = {
    pending: pending.length,
    enriched: 0,
    unanswered: 0,
    failedBatches: 0,
    batches: 0,
    errors: [],
  };

  for (let i = 0; i < pending.length; i += DETAILS_BATCH_SIZE) {
    const batch = pending.slice(i, i + DETAILS_BATCH_SIZE);
    result.batches++;

    let details: Map<number, WordDetails>;
    try {
      details = await enrichBatch(batch);
    } catch (e) {
      // Transport: nothing was learned, so nothing is stamped and the next sweep retries. (A
      // semantic miss is the opposite — writeDetails stamps it and it is never asked about again.)
      result.failedBatches++;
      result.errors.push(`enrich: ${e instanceof Error ? e.message : String(e)}`);
      opts.onBatch?.(Math.min(i + DETAILS_BATCH_SIZE, pending.length), pending.length);
      continue;
    }

    try {
      await writeDetails(batch, details);
      result.enriched += details.size;
      result.unanswered += batch.length - details.size;
    } catch (e) {
      // Distinct from transport: these payloads were produced and paid for, and are being discarded.
      result.failedBatches++;
      result.errors.push(
        `write (${details.size} payload(s) produced but NOT saved — they will be re-generated and ` +
          `re-billed next run): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    opts.onBatch?.(Math.min(i + DETAILS_BATCH_SIZE, pending.length), pending.length);
  }
  return result;
}
