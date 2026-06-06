import type { SkippedEntry } from "@idiomatic/contracts";
import { classifyInput, type TeachabilityResult } from "./teachability";

/**
 * Decide whether a submission can become a lesson, mapping the input-guardrail
 * requirements (FR-004/005/006/007) to a single typed outcome the API route can act on.
 */

export type SubmissionDecision =
  | { ok: true; result: TeachabilityResult; acceptedCount: number; skipped: SkippedEntry[] }
  | { ok: false; code: "empty_input"; status: 400; message: string }
  | { ok: false; code: "no_teachable_items"; status: 400; message: string; skipped: SkippedEntry[] }
  | { ok: false; code: "too_many_items"; status: 413; message: string; limit: number; received: number };

export function decideSubmission(
  input: string | string[],
  maxTeachableItems: number,
): SubmissionDecision {
  const result = classifyInput(input);

  // FR-004: nothing submitted at all.
  if (result.items.length === 0) {
    return {
      ok: false,
      code: "empty_input",
      status: 400,
      message: "Add at least one word, sentence, or idiom to generate a lesson.",
    };
  }

  // FR-007: entries present but none teachable.
  if (result.accepted.length === 0) {
    return {
      ok: false,
      code: "no_teachable_items",
      status: 400,
      message:
        "We couldn't find any teachable English words, sentences, or idioms in your list. Please revise and try again.",
      skipped: result.skipped,
    };
  }

  // FR-005: too many teachable items — state the limit, do not silently drop.
  if (result.accepted.length > maxTeachableItems) {
    return {
      ok: false,
      code: "too_many_items",
      status: 413,
      message: `You submitted ${result.accepted.length} teachable items, but a lesson supports up to ${maxTeachableItems}. Please trim your list.`,
      limit: maxTeachableItems,
      received: result.accepted.length,
    };
  }

  // FR-006: proceed with teachable items; skipped entries are reported.
  return {
    ok: true,
    result,
    acceptedCount: result.accepted.length,
    skipped: result.skipped,
  };
}
