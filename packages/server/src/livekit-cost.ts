import type { TurnRecord } from "@tutor/shared/tutor/livekit-wire";

export interface ModelRates {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface CostEvidence {
  /** USD per million tokens, keyed by exact ledger model. Supply dated billing rates. */
  rates: Record<string, ModelRates>;
  rateSource: string;
  /** Invoice amounts allocated ONLY to the selected conversations, including observability. */
  invoices?: { livekit: number; deepgram: number; elevenlabs: number; observability: number };
  invoiceSource?: string;
}

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

/** Token buckets are disjoint: inputTokens is already the uncached input. */
export function lessonTokenCost(turns: TurnRecord[], rates: CostEvidence["rates"]): number {
  if (!turns.length) throw new Error("No ledger rows; cannot measure cost");
  const seen = new Set<number>();
  for (const [index, turn] of [...turns].sort((a, b) => a.seq - b.seq).entries()) {
    if (turn.seq !== index) throw new Error("Incomplete or duplicate ledger sequence");
  }
  return turns.reduce((total, turn) => {
    if (seen.has(turn.seq)) throw new Error(`Duplicate turn ${turn.seq}`);
    seen.add(turn.seq);
    const rate = rates[turn.model];
    if (!rate) throw new Error(`Missing rates for model ${turn.model}`);
    return (
      total +
      (nonnegative(turn.inputTokens, "input tokens") * nonnegative(rate.input, "input rate") +
        nonnegative(turn.cacheReadTokens, "cache reads") *
          nonnegative(rate.cacheRead, "cache read rate") +
        nonnegative(turn.cacheWriteTokens, "cache writes") *
          nonnegative(rate.cacheWrite, "cache write rate") +
        nonnegative(turn.outputTokens, "output tokens") * nonnegative(rate.output, "output rate")) /
        1_000_000
    );
  }, 0);
}

export function costSummary(
  lessons: { conversationId: string; durationSecs: number; turns: TurnRecord[] }[],
  evidence: CostEvidence,
) {
  if (!lessons.length || !evidence.rateSource?.trim())
    throw new Error("Lessons and rateSource required");
  if (new Set(lessons.map((l) => l.conversationId)).size !== lessons.length) {
    throw new Error("Duplicate conversation");
  }
  const rows = lessons.map((lesson) => {
    if (!Number.isFinite(lesson.durationSecs) || lesson.durationSecs <= 0) {
      throw new Error(`Missing positive session duration for ${lesson.conversationId}`);
    }
    const claudeUsd = lessonTokenCost(lesson.turns, evidence.rates);
    return {
      conversationId: lesson.conversationId,
      minutes: lesson.durationSecs / 60,
      turns: lesson.turns.length,
      tokens: lesson.turns.reduce(
        (usage, turn) => ({
          input: usage.input + turn.inputTokens,
          cacheRead: usage.cacheRead + turn.cacheReadTokens,
          cacheWrite: usage.cacheWrite + turn.cacheWriteTokens,
          output: usage.output + turn.outputTokens,
        }),
        { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      ),
      claudeUsd,
      claudeUsdPerMinute: claudeUsd / (lesson.durationSecs / 60),
    };
  });
  const minutes = rows.reduce((n, row) => n + row.minutes, 0);
  const claudeUsd = rows.reduce((n, row) => n + row.claudeUsd, 0);
  let invoiceUsd: number | null = null;
  if (evidence.invoices) {
    if (!evidence.invoiceSource?.trim())
      throw new Error("invoiceSource required for invoice allocation");
    invoiceUsd = (["livekit", "deepgram", "elevenlabs", "observability"] as const).reduce(
      (sum, key) => sum + nonnegative(evidence.invoices![key], `${key} invoice`),
      0,
    );
  }
  const allInUsdPerMinute = invoiceUsd === null ? null : (claudeUsd + invoiceUsd) / minutes;
  return {
    lessons: rows,
    minutes,
    claudeUsd,
    claudeUsdPerMinute: claudeUsd / minutes,
    invoices: evidence.invoices ?? null,
    rateSource: evidence.rateSource,
    ratesUsdPerMillionTokens: evidence.rates,
    invoiceSource: evidence.invoiceSource ?? null,
    allInUsdPerMinute,
    // This reports the price threshold only. Five scripted 20-minute lessons remain an L7 prerequisite.
    costThreshold:
      allInUsdPerMinute === null ? "unmeasured" : allInUsdPerMinute <= 0.08 ? "pass" : "fail",
    qualification:
      "Ledger-based Claude cost; reconcile missing/aborted requests against vendor usage before the L7 decision.",
  };
}
