/** How a typed string becomes a word — the one place any client normalizes vocabulary text. Only Postgres owns the real identity.
 *  See ../../docs/words.md. */
export const MAX_WORD_LENGTH = 500;

export function wordInputKey(raw: string): string {
  return raw.trim().slice(0, MAX_WORD_LENGTH);
}

export function clientDedupeKey(raw: string): string {
  return wordInputKey(raw).toLowerCase();
}

const SMART_PUNCTUATION: Record<string, string> = {
  "’": "'",
  "‘": "'",
  ʼ: "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "\u00A0": " ",
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "−": "-",
  ß: "ss",
};

const EDGE_PUNCTUATION = " .,;:!?\"'`()[]{}…-";

export function lexiconPrefixFold(raw: string): string {
  let s = raw.normalize("NFKC");
  s = s.replace(
    /[\u2019\u2018\u02BC\u201C\u201D\u2013\u2014\u00A0\u2010\u2011\u2012\u2212\u00DF]/g,
    (ch) => SMART_PUNCTUATION[ch] ?? ch,
  );
  s = s
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .normalize("NFC");
  s = s.toLowerCase();
  s = s.replace(/\s+/g, " ");

  let start = 0;
  let end = s.length;
  while (start < end && EDGE_PUNCTUATION.includes(s[start]!)) start++;
  while (end > start && EDGE_PUNCTUATION.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}
