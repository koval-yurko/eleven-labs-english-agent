/**
 * Client-safe tutor session constants and types, shared by the browser tutor component,
 * the lesson data layer, and the post-call webhook. No server imports here.
 */
import type { WordDetails } from "./word-details";

/** One turn of a tutor conversation as stored in lesson_sessions.transcript. */
export interface TranscriptLine {
  role: "user" | "agent";
  text: string;
  timeInCallSecs?: number;
}

/** One active lesson item handed to the tutor: its text plus the curated enrichment payload
 *  (`null` = not enriched yet). `details` is the same `words.details` the detail page renders. */
export interface TutorItem {
  text: string;
  details: WordDetails | null;
}

/**
 * Build the `{{items_list}}` dynamic variable for a tutor session. This value is injected into the
 * agent's SYSTEM PROMPT (not spoken through TTS), so structured multi-line text is fine — the
 * "speech-shaped, no lists" rule governs the tutor's own spoken output, never this reference data.
 *
 * Each item is numbered. An enriched item (details present) carries a compact reference block that
 * the words-1.3 prompt PRESENTS instead of inventing; an un-enriched item is a plain line the tutor
 * teaches from its own knowledge (the words-1.2 fallback). A lesson routinely mixes the two.
 * See docs/2026-07-18-word-details-as-tutor-source.md.
 */
export function formatItemsList(items: TutorItem[]): string {
  return items
    .map((it, i) => {
      const n = i + 1;
      const d = it.details;
      if (!d) return `${n}. ${it.text}`;

      const lines = [`${n}. ${it.text}`];
      if (d.translations_ru.length > 0) lines.push(`   ru: ${d.translations_ru.join(", ")}`);
      if (d.pos) lines.push(`   pos: ${d.pos}`);
      if (d.forms.length > 0) {
        const forms = d.forms
          .map((f) => {
            const ru = f.translations_ru.length > 0 ? ` — ${f.translations_ru.join(", ")}` : "";
            return `${f.text} (${f.pos})${ru}`;
          })
          .join("; ");
        lines.push(`   forms: ${forms}`);
      }
      if (d.examples.length > 0) {
        const ex = d.examples.map((e) => `"${e.text}"${e.form ? ` (${e.form})` : ""}`).join("; ");
        lines.push(`   examples: ${ex}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Hidden message the browser sends the instant the session connects, so the agent greets
 * and starts teaching ON ITS OWN — the learner never has to speak first (an empty
 * first_message makes the agent wait; a user message reliably triggers its opening turn).
 * Both the live transcript UI and the stored history filter it out, so the record reads
 * as the teacher speaking first.
 */
export const KICKOFF_MESSAGE =
  "Let's begin. Greet me in one sentence and start teaching the first item now.";
