/**
 * The CEFR classification prompt for the LEXICON pass — a sibling of `levels-prompt.ts`, not a
 * reuse of it. Its own file so a prompt change is a reviewable diff.
 *
 * Three things differ from the `words` prompt, and each is a consequence of what is being levelled:
 *
 *   1. **A1 is a real answer here.** `levels-prompt.ts` floors at A2 because `CEFR_LEVELS` does —
 *      "A1 is headroom; the UI offers A2–C2" (0004) — and because a learner does not add `the` to
 *      their collection. A dictionary contains `the`. CEFR-J grades 1,058 of these rows A1 and the
 *      requirement was explicitly "A1 – C2", so the floor is removed.
 *   2. **The Russian gloss is given, and it is the point.** Rule 1 of the `words` prompt asks the
 *      model to guess which sense of a polysemous word was meant — the single largest source of
 *      error in CEFR labelling, and a guess it makes with no information. Here the sense is already
 *      pinned by the data: `issue` arrives with `вопрос, проблема` attached. This is context the
 *      other job simply does not have.
 *   3. **No `kind`.** These are dictionary headwords: single words, with 155 multiword entries out
 *      of 53k. The phrase/sentence guidance would be noise.
 *
 * Editing this only affects rows levelled from now on — the job skips anything with a `level_at`.
 * Run `pnpm level:lexicon --force` to re-level what the job has already answered.
 */

export const LEXICON_LEVEL_SYSTEM_PROMPT = `You assign CEFR levels to English dictionary headwords.

For each item, reply with the CEFR level at which a learner of English would typically be expected
to know and use it: A1, A2, B1, B2, C1, or C2.

Each item comes with its Russian translation(s). Rules:

1. SENSE. The Russian translation tells you WHICH SENSE of the headword to level. Many English
   words have several senses at very different levels; level the sense the translation names, not
   the most advanced sense you can think of and not a rare or technical one.

2. RANGE. The full A1-C2 range is available and you should use all of it. A1 is for the most
   basic function words and everyday vocabulary a beginner meets in their first weeks ("the",
   "water", "go"). C2 is for words a highly proficient speaker knows and an educated native
   speaker might still pause over ("ubiquity", "perfidious").

3. SPREAD. Do not default to B2 when unsure. Commit to the level you actually believe. A
   dictionary sampled at random skews HARDER than a learner's syllabus does, because most of the
   words in any dictionary are uncommon ones — expect far more C1 and C2 than A1 and A2.

4. FORMS. Level a derived form on its own merits, not its root's. "ubiquitous" and "ubiquity" are
   not automatically the same level, and an -ly adverb is usually a little harder than the
   adjective it comes from.

5. COVERAGE. Return exactly one entry for every index you are given, and use no levels other than
   A1, A2, B1, B2, C1, C2. Never invent an index.

6. OMIT RATHER THAN GUESS. If an item is not really English, is a proper noun, an abbreviation, or
   a fragment that no learner would study as vocabulary, OMIT it. An omitted item is recorded as
   unlevelled, which is a normal and permanent state — it is not a failure, and it is much better
   than a confident level on a word that should not be in a study list at all.`;

/** One row of the batch. `key` is carried for the caller's bookkeeping, never sent to the model. */
export interface LexiconLevelItem {
  key: string;
  text: string;
  ru: string[];
}

/**
 * The batch as an indexed list — the indices are what results are keyed back by.
 *
 * Keyed by index and never by echoed text, for the reason `levels.ts` documents: a reordered or
 * reworded answer would silently mis-assign levels across the whole batch, and a silent
 * mis-assignment is far worse here than a missing one.
 */
export function buildLexiconLevelPrompt(items: LexiconLevelItem[]): string {
  const lines = items.map((it, i) => {
    const ru = it.ru.length > 0 ? ` — RU: ${it.ru.join(", ")}` : " — (no translation available)";
    return `${i}. ${JSON.stringify(it.text)}${ru}`;
  });
  return `Assign a CEFR level to each of these ${items.length} English headwords.\n\n${lines.join("\n")}`;
}
