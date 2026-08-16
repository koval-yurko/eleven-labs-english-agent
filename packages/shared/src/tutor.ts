/**
 * Client-safe tutor session constants and types, shared by the browser tutor component,
 * the lesson data layer, and the post-call webhook. No server imports here.
 */
import type { WordDetails } from "./word-types";

/** One turn of a tutor conversation as stored in lesson_sessions.transcript. */
export interface TranscriptLine {
  role: "user" | "agent";
  text: string;
  timeInCallSecs?: number;
}

/** Bounds on a stored transcript. A conversation is a jsonb column, not a log. */
export const MAX_TRANSCRIPT_LINES = 500;
export const MAX_TRANSCRIPT_LINE_CHARS = 4000;

/**
 * Coerce whatever a caller hands us into a storable transcript: keep only well-formed
 * user/agent turns, cap the line count and each line's length.
 *
 * Shared because FOUR paths converge on one `lesson_sessions` row keyed by conversation_id — the
 * server action, the `/api/lessons/session` beacon, the post-call webhook, and (later) a native
 * client. They must agree on what a stored transcript looks like, or the row's content depends on
 * which writer happened to land last. Sharing this does NOT move the trust boundary: the server
 * still sanitizes everything it receives, and still re-derives the owner from the session.
 *
 * Takes `unknown` on purpose — two of its callers are handling a parsed request body.
 *
 * `timeInCallSecs` is preserved when present (only the webhook has it, and only for some turns).
 * The line cap is applied BEFORE the validity filter, matching the original behaviour: a payload
 * whose first 500 entries include malformed ones yields fewer than 500 stored lines.
 */
export function sanitizeTranscript(lines: unknown): TranscriptLine[] {
  const raw: unknown[] = Array.isArray(lines) ? lines : [];
  const out: TranscriptLine[] = [];
  for (const entry of raw.slice(0, MAX_TRANSCRIPT_LINES)) {
    const line = entry as Partial<TranscriptLine> | null | undefined;
    if (!line || (line.role !== "user" && line.role !== "agent")) continue;
    if (typeof line.text !== "string") continue;
    const clean: TranscriptLine = {
      role: line.role,
      text: line.text.slice(0, MAX_TRANSCRIPT_LINE_CHARS),
    };
    if (typeof line.timeInCallSecs === "number") clean.timeInCallSecs = line.timeInCallSecs;
    out.push(clean);
  }
  return out;
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

/**
 * Kickoff message for a session that is picking up an interrupted one (the phone locked, the app
 * was backgrounded, iOS interrupted the audio). Sent right after a `sendContextualUpdate` carrying
 * `formatResumeContext`, so the tutor continues instead of starting the lesson over. Filtered out
 * of the visible transcript and the stored history exactly like KICKOFF_MESSAGE.
 */
export const RESUME_MESSAGE =
  "We got cut off. Pick up exactly where we stopped — one short sentence to re-orient me, then continue.";

/**
 * Kickoff message for a session the learner PAUSED on purpose and has just resumed.
 *
 * Separate from RESUME_MESSAGE because the platform has no pause: a resumed lesson is a brand-new
 * conversation either way (docs/2026-08-16-tutor-session-pause-resume.md §3.6), so the only thing
 * that distinguishes "the phone locked" from "I stepped away" is what we tell the tutor. Saying
 * "we got cut off" to someone who pressed Pause is a small lie the tutor would then speak aloud.
 */
export const PAUSE_RESUME_MESSAGE =
  "I'm back. Pick up exactly where we stopped — one short sentence to re-orient me, then continue.";

/**
 * Hidden kickoff messages, filtered out of the transcript UI and the saved history.
 *
 * Every writer that stores a transcript must filter on THIS ARRAY, not on a single constant — the
 * post-call webhook filtered only `KICKOFF_MESSAGE` until 2026-08-16, so `RESUME_MESSAGE` reached
 * the stored history as a learner turn whenever the webhook happened to write last.
 */
export const HIDDEN_KICKOFF_MESSAGES: readonly string[] = [
  KICKOFF_MESSAGE,
  RESUME_MESSAGE,
  PAUSE_RESUME_MESSAGE,
];

/** Why a conversation is being picked up: something took it, or the learner put it down. */
export type ResumeCause = "interrupted" | "paused";

/** How many trailing turns of the interrupted conversation we replay as context. */
const RESUME_CONTEXT_TURNS = 20;
const RESUME_CONTEXT_LINE_CHARS = 400;

const RESUME_PREAMBLE: Record<ResumeCause, string> = {
  interrupted:
    "This session was interrupted (the learner's phone locked or the app went to the background) and has just been reconnected.",
  paused:
    "The learner paused this session on purpose and has just come back. Do not remark on the gap — simply carry on.",
};

/**
 * Compact recap of the conversation being picked up, sent to the resumed session as a contextual
 * update (non-interrupting, goes to the agent's context — not spoken). Only the tail matters: enough
 * for the tutor to know which items were covered and where the learner struggled, not the whole call.
 *
 * `cause` defaults to `"interrupted"` so the browser's call site — which has no pause control and
 * never will (the web UI is deprecated) — keeps its exact previous behaviour.
 */
export function formatResumeContext(
  lines: TranscriptLine[],
  cause: ResumeCause = "interrupted",
): string {
  const tail = lines.slice(-RESUME_CONTEXT_TURNS);
  if (tail.length === 0) return "";
  const body = tail
    .map(
      (l) =>
        `${l.role === "agent" ? "Teacher" : "Learner"}: ${l.text.slice(0, RESUME_CONTEXT_LINE_CHARS)}`,
    )
    .join("\n");
  return `${RESUME_PREAMBLE[cause]} Here is how it ended:\n${body}`;
}
