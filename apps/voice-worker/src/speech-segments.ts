/**
 * Cuts streaming text into the pieces the Qwen task is fed with.
 *
 * Model Studio synthesizes complete sentences as they arrive and buffers an unfinished one, so the
 * worker could forward raw tokens. It does not, for two reasons: the pacer (`pacer.ts`) needs
 * discrete pieces to hold back, and `continue-task` must be sent at least every 23 s or the
 * connection times out — a piece must never be so long that holding it back blows that budget.
 *
 * Pure: `check.ts` runs it on strings.
 */
export const MIN_PIECE_CHARS = 60;
/** ~15 s of speech at 17 chars/s: with the pacer's 12 s lookahead the gap between sends stays under 23 s. */
export const MAX_PIECE_CHARS = 250;

const SENTENCE_END = /[.!?…。！？]+["'”’)\]]*\s+/g;

export function segment(buffer: string, final: boolean): { pieces: string[]; rest: string } {
  const pieces: string[] = [];
  let rest = buffer;
  for (;;) {
    let cut = -1;
    for (const m of rest.matchAll(SENTENCE_END)) {
      const end = m.index + m[0].length;
      if (end >= MIN_PIECE_CHARS) {
        cut = end;
        break;
      }
    }
    if (cut < 0 && rest.length > MAX_PIECE_CHARS) {
      const window = rest.slice(0, MAX_PIECE_CHARS);
      const soft = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
      cut = soft >= MIN_PIECE_CHARS ? soft + 2 : window.lastIndexOf(" ") + 1 || MAX_PIECE_CHARS;
    }
    if (cut < 0) break;
    // A sentence longer than the cap is cut at the cap, not just where it happens to end.
    if (cut > MAX_PIECE_CHARS) {
      const window = rest.slice(0, MAX_PIECE_CHARS);
      cut = window.lastIndexOf(" ") + 1 || MAX_PIECE_CHARS;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (final && rest.trim()) {
    pieces.push(rest);
    rest = "";
  }
  return { pieces, rest };
}
