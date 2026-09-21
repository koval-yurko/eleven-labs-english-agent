import assert from "node:assert/strict";
import { costSummary, lessonTokenCost } from "../src/lib/livekit-cost";
import type { TurnRecord } from "@tutor/shared/tutor/livekit-wire";

// Synthetic rates, not vendor pricing. Cached tokens must never be charged as uncached too.
const rates = { test: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 } };
const turn = {
  seq: 0,
  model: "test",
  inputTokens: 100,
  cacheReadTokens: 1000,
  cacheWriteTokens: 200,
  outputTokens: 50,
  preemptiveAttempts: 1,
} as TurnRecord;
assert.equal(lessonTokenCost([turn], rates), 0.0014);
assert.throws(() => lessonTokenCost([turn], {}), /Missing rates/);
assert.throws(() => lessonTokenCost([turn, turn], rates), /duplicate/i);
assert.throws(() => lessonTokenCost([{ ...turn, inputTokens: -1 }], rates), /Invalid/);
assert.throws(() => lessonTokenCost([], rates), /No ledger/);
assert.throws(() => lessonTokenCost([{ ...turn, seq: 1 }], rates), /Incomplete/);
const lessons = [
  { conversationId: "a", durationSecs: 60, turns: [turn] },
  { conversationId: "b", durationSecs: 180, turns: [turn] },
];
const evidence = { rates, rateSource: "synthetic test" };
assert.equal(costSummary(lessons, evidence).claudeUsdPerMinute, 0.0007);
assert.equal(costSummary(lessons, evidence).costThreshold, "unmeasured");
assert.equal(
  costSummary(lessons, {
    ...evidence,
    invoiceSource: "test allocation",
    invoices: { livekit: 0.1, deepgram: 0.1, elevenlabs: 0.1, observability: 0.1 },
  }).costThreshold,
  "fail",
);
assert.throws(() => costSummary([{ ...lessons[0]!, durationSecs: 0 }], evidence), /duration/);
assert.throws(
  () => costSummary(lessons, { ...evidence, invoices: {} as never, invoiceSource: "test" }),
  /Invalid/,
);
console.log(
  "LiveKit cost checks passed (cache accounting, weighted duration, missing evidence, invalid inputs).",
);
