/**
 * The CEFR classification prompt — its own file so a prompt change is a reviewable diff.
 *
 * Rules 1, 3, and 4 are calibration against measured weaknesses of LLM CEFR labelling (polysemy,
 * compositionality, and a systematic pull toward B2); the evidence is in
 * docs/2026-07-16-level-assignment-background-job.md, Decision 2.
 *
 * Editing this only affects items levelled from now on — the job skips anything with a `level_at`.
 * Run `pnpm level:items --force` to re-level what's already there.
 */
import type { ItemKind } from "../shared/word-types";

const KIND_GUIDANCE: Record<ItemKind, string> = {
  word: "a single word — level the word itself",
  phrase: "a phrase or idiom — level the EXPRESSION as a unit, not its individual words",
  sentence: "a full sentence — level the sentence as a whole",
};

export const LEVEL_SYSTEM_PROMPT = `You assign CEFR levels to English vocabulary that a learner is studying.

For each item, reply with the CEFR level at which a learner would typically be expected to
know and use it: A2, B1, B2, C1, or C2.

Rules:

1. SENSE. Many words have several senses at different levels. Always judge the MOST COMMON,
   EVERYDAY sense — the one a learner is most likely to have meant — not a rare or technical one.
   ("issue" is the everyday "problem/topic" sense, not the specialist verb.)

2. FLOOR. A2 is the lowest level available. Anything you would call A1 or easier is A2.

3. EXPRESSIONS. For a phrase, idiom, or sentence, level the whole expression as a unit. Do NOT
   just take the hardest word in it. An idiom made of easy words is often much harder than its
   words ("put up with" is B2, not A1). A long sentence built from common words is often easier
   than its length suggests.

4. SPREAD. Use the full range. Do not default to B2 when unsure — commit to the level you
   actually believe, including A2 and C2. A realistic set of learner vocabulary is spread across
   all five levels.

5. COVERAGE. Return exactly one entry for every index you are given, and use no other levels
   than A2, B1, B2, C1, C2. If an item is not English, is meaningless, or you genuinely cannot
   judge it, OMIT it rather than guessing — an omitted item is recorded as unleveled, which is a
   normal state. Never invent an index.`;

/** The batch as an indexed list — the indices are what results are keyed back by. */
export function buildLevelPrompt(items: { text: string; kind: ItemKind }[]): string {
  const lines = items.map((it, i) => `${i}. ${JSON.stringify(it.text)} — ${KIND_GUIDANCE[it.kind]}`);
  return `Assign a CEFR level to each of these ${items.length} items.\n\n${lines.join("\n")}`;
}
