import type { ItemType, SkipReason, SkippedEntry } from "@idiomatic/contracts";

/**
 * Teachability classification + normalization + dedupe (research R9).
 *
 * Deterministic heuristics so the input-guardrail branches (FR-002..FR-007) and
 * the dedupe rule (FR-003) are testable without a live LLM. A richer LLM-backed
 * classifier can be layered in later behind the same `ClassifiedItem` shape; the
 * obvious cases handled here are real and stable.
 */

export interface ClassifiedItem {
  id: string;
  rawText: string;
  normalizedText: string;
  itemType: ItemType;
  teachable: boolean;
  skipReason: SkipReason | null;
  orderIndex: number;
}

export interface TeachabilityResult {
  items: ClassifiedItem[];
  accepted: ClassifiedItem[];
  skipped: SkippedEntry[];
}

const MAX_DISCRETE_WORDS = 30;
const MAX_DISCRETE_CHARS = 250;

/** Split raw input into trimmed, non-empty entries (research R8). */
export function parseEntries(input: string | string[]): string[] {
  const lines = Array.isArray(input) ? input : input.split(/\r?\n/);
  return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLatinText(text: string): boolean {
  // Basic Latin letters, digits, common punctuation/whitespace only.
  return /^[\p{Script=Latin}\d\s'’"“”\-.,!?;:()&/]+$/u.test(text);
}

function vowelRatio(token: string): number {
  const letters = token.replace(/[^a-z]/gi, "");
  if (letters.length === 0) return 0;
  const vowels = letters.replace(/[^aeiouy]/gi, "").length;
  return vowels / letters.length;
}

function looksLikeGibberish(normalized: string): boolean {
  const words = normalized.split(" ");
  // Single token with no vowels, or digits-only, or an implausible vowel ratio.
  if (words.length === 1) {
    const w = words[0]!;
    if (/^\d+$/.test(w)) return true;
    const letters = w.replace(/[^a-z]/gi, "");
    if (letters.length >= 3 && vowelRatio(w) === 0) return true;
    if (letters.length >= 6 && vowelRatio(w) < 0.2) return true;
  }
  return false;
}

function classifyType(normalized: string): ItemType {
  const words = normalized.split(" ");
  const endsSentence = /[.!?]$/.test(normalized);
  if (words.length === 1) return "word";
  if (endsSentence || words.length >= 7) return "sentence";
  return "idiom";
}

function classifyOne(
  rawText: string,
  orderIndex: number,
  seen: Set<string>,
): ClassifiedItem {
  const normalizedText = normalize(rawText);
  const dedupeKey = normalizedText.toLowerCase();
  const id = `item-${orderIndex}`;

  let skipReason: SkipReason | null = null;
  if (seen.has(dedupeKey)) {
    skipReason = "duplicate";
  } else if (!isLatinText(normalizedText)) {
    skipReason = "non_english";
  } else if (looksLikeGibberish(normalizedText)) {
    skipReason = "gibberish";
  } else if (
    normalizedText.length > MAX_DISCRETE_CHARS ||
    normalizedText.split(" ").length > MAX_DISCRETE_WORDS
  ) {
    skipReason = "not_discrete";
  }

  if (skipReason !== "duplicate") {
    seen.add(dedupeKey);
  }

  return {
    id,
    rawText,
    normalizedText,
    itemType: classifyType(normalizedText),
    teachable: skipReason === null,
    skipReason,
    orderIndex,
  };
}

/** Classify every parsed entry; preserve submission order. */
export function classifyEntries(entries: string[]): TeachabilityResult {
  const seen = new Set<string>();
  const items = entries.map((raw, idx) => classifyOne(raw, idx, seen));
  const accepted = items.filter((i) => i.teachable);
  const skipped: SkippedEntry[] = items
    .filter((i) => !i.teachable && i.skipReason !== null)
    .map((i) => ({ rawText: i.rawText, reason: i.skipReason! }));
  return { items, accepted, skipped };
}

export function classifyInput(input: string | string[]): TeachabilityResult {
  return classifyEntries(parseEntries(input));
}
