/**
 * The word-details enrichment prompt — its own file so a prompt change is a reviewable diff, the
 * same rule as levels-prompt.ts.
 *
 * The substance (Russian translations, the full word family, examples across forms) is the curated
 * counterpart of the spoken tutor content designed in
 * docs/2026-07-08-words-1.2-russian-translations-and-word-forms.md §4 — retargeted from speech to a
 * structured JSON document. The output shape is enforced by `.withStructuredOutput()` in
 * src/lib/word-details.ts, so this prompt only steers CONTENT quality, not format.
 *
 * Editing this only affects words enriched from now on — the job skips anything with a `details_at`.
 * Run `pnpm enrich:words --force` (or `--force --stale`) to re-enrich what's already there.
 */
import type { ItemKind } from "@tutor/shared/words/types";

const KIND_GUIDANCE: Record<ItemKind, string> = {
  word: 'a single word — give its word family (noun, verb, adjective, adverb, common prefixed/negated relatives)',
  phrase:
    'a phrase, idiom, or phrasal verb — treat "forms" as its structural variants (tense, person, which slots swap), not the forms of its individual words',
  sentence:
    'a full sentence — "forms" is usually empty; give one or two natural rephrasings as examples instead',
};

export const DETAILS_SYSTEM_PROMPT = `You enrich English vocabulary that a learner (a Russian speaker) is studying. For each item you are given, produce a structured record with four parts:

1. POS — the part of speech of the item exactly as listed ("verb", "noun", "adjective", "phrasal verb", "phrase", "sentence"). Judge the MOST COMMON, EVERYDAY sense — the one the learner most likely meant — not a rare or technical one.

2. TRANSLATIONS — several Russian translations of the item, best/most-common sense first, then other shades of meaning. Give real, natural Russian (Cyrillic), not a transliteration. For a phrase or sentence, give the natural Russian EQUIVALENT (how a Russian speaker would actually say it), not a word-by-word gloss.

3. FORMS — the rest of the word family: each related form with its own part of speech and its own Russian translations. Example for "decide": decision (noun), decisive (adjective), decisively (adverb), undecided (adjective). Rules:
   - Do NOT invent forms. If a form does not exist (e.g. no adverb), simply omit it — a made-up form is worse than a short list.
   - Keep it to the genuinely common members of the family, up to about five.
   - For a phrase/idiom/sentence, follow the item-specific guidance you are given for what "forms" means.

4. EXAMPLES — a few short, natural English sentences that show the item and its forms in use, spread across the forms above (aim for at least one per major form, up to about four total). For each example, name which form it demonstrates, and give a natural Russian translation of the whole sentence.

Overall rules:
- Answer for the everyday sense throughout — translations, forms, and examples must all be about the SAME common sense.
- Keep everything tight: a handful of translations, up to ~5 forms, up to ~4 examples.
- If an item is not English, is meaningless, or you genuinely cannot enrich it, OMIT it entirely rather than inventing — an omitted item is recorded as un-enriched, which is a normal state. Never invent an index.
- Return at most one entry per index you are given, keyed by that index. Never invent an index.`;

/** The batch as an indexed list — the indices are what results are keyed back by. */
export function buildDetailsPrompt(items: { text: string; kind: ItemKind }[]): string {
  const lines = items.map(
    (it, i) => `${i}. ${JSON.stringify(it.text)} — ${KIND_GUIDANCE[it.kind]}`,
  );
  return `Enrich each of these ${items.length} items.\n\n${lines.join("\n")}`;
}
