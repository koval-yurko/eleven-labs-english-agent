/**
 * SERVER-ONLY: the CEFR level pass over the `lexicon` table.
 *
 * Phase 1 of docs/2026-08-15-word-autocomplete-suggestions.md. 0010 loaded 53,538 dictionary rows
 * and only 8,301 carry a level, because that is all the open CEFR lists cover — `ubiquitous`, the
 * placeholder in the app's own add-word field, is in none of them. This fills the other 45k so the
 * suggestion dropdown can show a level on most rows instead of on one in seven.
 *
 * ── How this differs from `levels.ts`, and why it is a separate module ──────────────────────
 *
 * `levels.ts` levels the LEARNER'S OWN WORDS: a handful at a time, on the request path via
 * `after()`, where latency is the constraint and the cost is a rounding error. This levels a
 * DICTIONARY: 45,315 rows, once, offline, where latency does not exist and cost is the only
 * constraint. Those are different problems and they want different machinery —
 *
 *   | | `levels.ts` | this |
 *   | --- | --- | --- |
 *   | Transport | LangChain, synchronous | **Message Batches API**, async — 50% off list |
 *   | Trigger | `after()` + `pnpm level:items` | one CLI run |
 *   | Scale | tens | 1,813 requests in a single batch |
 *   | Floor | A2 (`CEFR_LEVELS`) | **A1** — a dictionary contains `the` |
 *   | Sense | guessed from the word alone | **given**, by the Russian gloss |
 *
 * The Batches API is why this does not go through LangChain, which `CLAUDE.md` otherwise requires:
 * LangChain has no binding for it, and the 50% discount is not incidental — it is half of the
 * approved cost in the doc's D2. The trade is LangSmith auto-tracing, which buys little for a
 * one-off offline pass that reports its own accuracy against a human-graded eval set.
 *
 * ── Resumability ────────────────────────────────────────────────────────────────────────────
 *
 * A batch takes minutes to hours, which is longer than anyone will hold a terminal open. Every
 * submission writes a MANIFEST — the batch id plus, per request, the ordered keys it asked about —
 * so a run can be collected later, or after a crash, by a different process. The manifest is
 * load-bearing and not a cache: results come back keyed by request and by INDEX WITHIN the request,
 * and nothing in the response says which word index 7 of request 412 was.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type pg from "pg";
import { LEXICON_LEVELS, type LexiconLevel } from "@tutor/shared/words/types";
import {
  LEXICON_LEVEL_SYSTEM_PROMPT,
  buildLexiconLevelPrompt,
  type LexiconLevelItem,
} from "./lexicon-levels-prompt";

/** Headwords per request. Same blast radius as `levels.ts`: one failed request costs this many. */
export const LEXICON_BATCH_SIZE = 25;

/**
 * Deliberately not `ANTHROPIC_MODEL`. That variable steers the app's REQUEST-TIME model, where a
 * change is felt immediately and costs pennies; this is a one-off pass whose model choice is a
 * few dollars either way and should be made on the eval's evidence, not inherited from an unrelated
 * setting. `--model=claude-haiku-4-5` is the cheap option — run `--eval` on both and compare.
 */
export const DEFAULT_LEXICON_MODEL = "claude-opus-5";

/**
 * Output is `{index, level}` pairs and nothing else, so 25 items need a few hundred tokens. 4096 is
 * headroom, not a target — a truncated tool call fails to parse for the whole request, which is a
 * permanent failure wearing a transient's clothes.
 *
 * No extended thinking, on purpose: per-item this is a recall task, not a reasoning one, and
 * adaptive thinking across 1,813 requests would multiply the output bill that D2 was approved on.
 */
const MAX_TOKENS = 4096;

const LEVELS_TOOL = {
  name: "cefr_levels",
  description: "Record the CEFR level of each headword you were given.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "The index of the headword in the list." },
            level: { type: "string", enum: [...LEXICON_LEVELS] },
          },
          required: ["index", "level"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

// ── the manifest ──────────────────────────────────────────────────────────────────────────────

export interface BatchManifest {
  batchId: string;
  model: string;
  /** `run` writes levels back; `eval` scores them against the human CEFR values and writes nothing. */
  mode: "run" | "eval";
  submittedAt: string;
  collectedAt?: string;
  /** custom_id → the keys that request asked about, IN ORDER. The index is the join. */
  requests: Record<string, string[]>;
}

// ── reading the queue ─────────────────────────────────────────────────────────────────────────

export interface LexiconQueueRow extends LexiconLevelItem {
  /** Only set by `listEvalRows` — the human CEFR value being predicted, withheld from the model. */
  known?: LexiconLevel;
}

/**
 * The queue: rows with no level that have never been attempted, hardest-to-reach last.
 *
 * `level is null` protects the 8,301 human-graded rows from being asked about at all — the job
 * fills gaps, it does not overwrite Tono Laboratory. `level_at is null` retires a row the model
 * already declined. Ordered by zipf desc so a `--limit` run levels the words a learner is most
 * likely to type first.
 */
export async function listPendingRows(
  db: pg.Client,
  opts: { limit?: number } = {},
): Promise<LexiconQueueRow[]> {
  const { rows } = await db.query<LexiconQueueRow>(
    `select key, text, ru
       from lexicon
      where level is null and level_at is null
      order by zipf desc, key
      ${opts.limit ? "limit $1" : ""}`,
    opts.limit ? [opts.limit] : [],
  );
  return rows;
}

/**
 * The eval set, and the reason phase 1 has a gate at all: 8,301 rows whose level a human assigned.
 * Sampling them costs nothing extra and turns "does the model know CEFR?" into a number.
 *
 * `md5(key)` rather than `random()`: the same sample every time, so two models are compared on the
 * same words and a re-run of one model is reproducible.
 */
export async function listEvalRows(db: pg.Client, sample: number): Promise<LexiconQueueRow[]> {
  const { rows } = await db.query<LexiconQueueRow>(
    `select key, text, ru, level as known
       from lexicon
      where level is not null and level_source in ('cefrj', 'octanove')
      order by md5(key)
      limit $1`,
    [sample],
  );
  return rows;
}

/** Clear what the JOB wrote, so the next run re-levels it — what `--force` means. Never touches
 *  a human CEFR value: `level_source = 'job'` is the whole filter. */
export async function resetJobLevels(db: pg.Client): Promise<number> {
  const res = await db.query(
    `update lexicon set level = null, level_source = null, level_at = null
      where level_source = 'job' or (level_at is not null and level is null)`,
  );
  return res.rowCount ?? 0;
}

// ── submitting ────────────────────────────────────────────────────────────────────────────────

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  return new Anthropic({ apiKey });
}

export function chunk<T>(rows: T[], size = LEXICON_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function requestFor(items: LexiconQueueRow[], model: string): MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: LEXICON_LEVEL_SYSTEM_PROMPT,
    tools: [LEVELS_TOOL],
    // Forced, not offered: the only acceptable reply is the structured one, and letting the model
    // answer in prose would turn a parse failure into a silent unlevelled row.
    tool_choice: { type: "tool", name: LEVELS_TOOL.name },
    messages: [{ role: "user", content: buildLexiconLevelPrompt(items) }],
  };
}

/** Submit one batch and return the manifest that makes its results interpretable. */
export async function submitBatch(
  rows: LexiconQueueRow[],
  opts: { model: string; mode: "run" | "eval" },
): Promise<BatchManifest> {
  const groups = chunk(rows);
  const requests = groups.map((items, i) => ({
    // `^[a-zA-Z0-9_-]{1,64}$`, so the headword itself cannot be the id — apostrophes, spaces and
    // hyphens all appear in these keys. The ordinal plus the manifest carries the same information.
    custom_id: `r${i}`,
    params: requestFor(items, opts.model),
  }));

  const batch = await client().messages.batches.create({ requests });

  return {
    batchId: batch.id,
    model: opts.model,
    mode: opts.mode,
    submittedAt: new Date().toISOString(),
    requests: Object.fromEntries(groups.map((items, i) => [`r${i}`, items.map((it) => it.key)])),
  };
}

export interface BatchProgress {
  status: "in_progress" | "canceling" | "ended";
  succeeded: number;
  errored: number;
  processing: number;
  canceled: number;
  expired: number;
}

export async function batchProgress(batchId: string): Promise<BatchProgress> {
  const batch = await client().messages.batches.retrieve(batchId);
  const c = batch.request_counts;
  return {
    status: batch.processing_status,
    succeeded: c.succeeded,
    errored: c.errored,
    processing: c.processing,
    canceled: c.canceled,
    expired: c.expired,
  };
}

// ── collecting ────────────────────────────────────────────────────────────────────────────────

export interface CollectedLevels {
  /** key → level. Only entries the model actually answered. */
  levels: Map<string, LexiconLevel>;
  /** Keys the model was asked about and declined — stamped attempted, left unlevelled. */
  unanswered: string[];
  /** Requests that came back errored/expired/canceled. Nothing is stamped; re-run to retry. */
  failedRequests: number;
  errors: string[];
}

const LEVEL_SET = new Set<string>(LEXICON_LEVELS);

/**
 * Stream the batch's results and rejoin them to headwords through the manifest.
 *
 * Results may arrive out of request order — that is why they carry `custom_id`, and why the join is
 * (custom_id → ordered keys) → index, never the model's echo of the word.
 */
export async function collectBatch(manifest: BatchManifest): Promise<CollectedLevels> {
  const out: CollectedLevels = { levels: new Map(), unanswered: [], failedRequests: 0, errors: [] };
  const seen = new Set<string>();

  for await (const entry of await client().messages.batches.results(manifest.batchId)) {
    const keys = manifest.requests[entry.custom_id];
    if (!keys) {
      out.errors.push(`${entry.custom_id}: not in the manifest — ignored`);
      continue;
    }
    seen.add(entry.custom_id);

    if (entry.result.type !== "succeeded") {
      out.failedRequests++;
      // Errored is not the same as unanswered: nothing was learned, so nothing is stamped and the
      // next run asks again. Collapsing the two would retire a word the model never saw.
      const why =
        entry.result.type === "errored" ? JSON.stringify(entry.result.error) : entry.result.type;
      if (out.errors.length < 10) out.errors.push(`${entry.custom_id}: ${why}`);
      continue;
    }

    const block = entry.result.message.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      out.failedRequests++;
      if (out.errors.length < 10) out.errors.push(`${entry.custom_id}: no tool_use block in reply`);
      continue;
    }

    const answered = new Set<number>();
    const parsed = block.input as { items?: Array<{ index?: unknown; level?: unknown }> };
    for (const item of parsed.items ?? []) {
      const index = item.index;
      const level = typeof item.level === "string" ? item.level.trim().toUpperCase() : "";
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= keys.length)
        continue;
      if (!LEVEL_SET.has(level)) continue;
      const key = keys[index as number];
      if (key === undefined || answered.has(index as number)) continue;
      answered.add(index as number);
      out.levels.set(key, level as LexiconLevel);
    }
    keys.forEach((key, i) => {
      if (!answered.has(i)) out.unanswered.push(key);
    });
  }

  // A request whose result never appeared at all — batch still running, or expired mid-stream.
  for (const customId of Object.keys(manifest.requests)) {
    if (!seen.has(customId)) out.failedRequests++;
  }
  return out;
}

// ── writing ───────────────────────────────────────────────────────────────────────────────────

/** Keys per UPDATE. Postgres handles far larger arrays; this keeps one statement's failure legible. */
const WRITE_CHUNK = 5000;

/**
 * Stamp `level_at` on every row that was asked about, and `level` on the ones that got an answer.
 *
 * The answered/unanswered split is load-bearing for the same reason it is in `levels.ts`: an
 * unanswered row must get `level_at` and NOT `level`, because writing null over an existing level
 * would also mark it done and no later run would revisit it.
 *
 * One statement per level (six at most) plus one for the unanswered, all inside one transaction —
 * so a run either lands or does not, and a half-written pass cannot leave rows stamped as attempted
 * without their levels.
 */
export async function writeLevels(db: pg.Client, collected: CollectedLevels): Promise<number> {
  const now = new Date().toISOString();
  const byLevel = new Map<LexiconLevel, string[]>();
  for (const [key, level] of collected.levels) {
    const keys = byLevel.get(level) ?? [];
    keys.push(key);
    byLevel.set(level, keys);
  }

  let written = 0;
  await db.query("begin");
  try {
    for (const [level, keys] of byLevel) {
      for (const slice of chunk(keys, WRITE_CHUNK)) {
        const res = await db.query(
          `update lexicon set level = $1::cefr_level, level_source = 'job', level_at = $2
            where key = any($3::text[])`,
          [level, now, slice],
        );
        written += res.rowCount ?? 0;
      }
    }
    for (const slice of chunk(collected.unanswered, WRITE_CHUNK)) {
      await db.query("update lexicon set level_at = $1 where key = any($2::text[])", [now, slice]);
    }
    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
  return written;
}

// ── the eval ──────────────────────────────────────────────────────────────────────────────────

export interface EvalReport {
  n: number;
  answered: number;
  omitted: number;
  exact: number;
  withinOne: number;
  /** true level → predicted level → count. */
  confusion: Map<LexiconLevel, Map<LexiconLevel, number>>;
  /** Mean signed error in level steps: positive = the model grades HARDER than the humans. */
  bias: number;
}

export function scoreEval(rows: LexiconQueueRow[], collected: CollectedLevels): EvalReport {
  const rank = (l: LexiconLevel) => LEXICON_LEVELS.indexOf(l);
  const report: EvalReport = {
    n: rows.length,
    answered: 0,
    omitted: 0,
    exact: 0,
    withinOne: 0,
    confusion: new Map(),
    bias: 0,
  };
  let signed = 0;

  for (const row of rows) {
    const truth = row.known;
    if (!truth) continue;
    const predicted = collected.levels.get(row.key);
    if (!predicted) {
      report.omitted++;
      continue;
    }
    report.answered++;
    const delta = rank(predicted) - rank(truth);
    signed += delta;
    if (delta === 0) report.exact++;
    if (Math.abs(delta) <= 1) report.withinOne++;

    const row_ = report.confusion.get(truth) ?? new Map<LexiconLevel, number>();
    row_.set(predicted, (row_.get(predicted) ?? 0) + 1);
    report.confusion.set(truth, row_);
  }
  report.bias = report.answered > 0 ? signed / report.answered : 0;
  return report;
}
