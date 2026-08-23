/** Client-safe tutor session constants and types: the transcript, the message set, and the session's bounds.
 *  See ../../docs/tutor.md. */
import type { WordDetails } from "../words/types";

export interface TranscriptLine {
  role: "user" | "agent";
  text: string;
  timeInCallSecs?: number;
}

export const MAX_TRANSCRIPT_LINES = 500;
export const MAX_TRANSCRIPT_LINE_CHARS = 4000;

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

export interface TutorItem {
  text: string;
  details: WordDetails | null;
}

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

export const KICKOFF_MESSAGE =
  "Let's begin. Greet me in one sentence and start teaching the first item now.";

export const RESUME_MESSAGE =
  "We got cut off. Pick up exactly where we stopped — one short sentence to re-orient me, then continue.";

export const PAUSE_RESUME_MESSAGE =
  "I'm back. Pick up exactly where we stopped — one short sentence to re-orient me, then continue.";

export const PAUSE_STOP_MESSAGE =
  "[The learner just paused the lesson and can no longer hear you.] Stop speaking immediately. Do not answer this, do not summarise, say nothing at all.";

export const ABORTED_RESUME_MESSAGE =
  "I'm back — you were cut off mid-sentence. Finish just that thought in a sentence or two, then carry on. Do not start the item over.";

export const UNHEARD_RESUME_MESSAGE =
  "I'm back — I didn't hear your last point. Repeat just that one, in two or three sentences, then carry on. Do not repeat anything before it.";

export const HIDDEN_KICKOFF_MESSAGES: readonly string[] = [
  KICKOFF_MESSAGE,
  RESUME_MESSAGE,
  PAUSE_RESUME_MESSAGE,
  PAUSE_STOP_MESSAGE,
  ABORTED_RESUME_MESSAGE,
  UNHEARD_RESUME_MESSAGE,
  "I'm back — I didn't hear what you said while I was away. Recap that briefly, then carry on.",
];

export type ResumeCause = "interrupted" | "paused";

const RESUME_CONTEXT_TURNS = 20;
const RESUME_CONTEXT_LINE_CHARS = 400;

const RESUME_PREAMBLE: Record<ResumeCause, string> = {
  interrupted:
    "This session was interrupted (the learner's phone locked or the app went to the background) and has just been reconnected.",
  paused:
    "The learner paused this session on purpose and has just come back. Do not remark on the gap — simply carry on.",
};

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

export const PAUSE_CONTEXT =
  "The learner has paused the lesson and stepped away. Their microphone is muted and they cannot hear you. Say nothing at all until they come back — do not greet, do not prompt, do not ask if they are still there.";

export function formatHeldResumeContext(pausedSeconds: number): string {
  const secs = Math.max(0, Math.round(pausedSeconds));
  const gap =
    secs < 90 ? `${secs} seconds` : `about ${Math.round(secs / 60)} minutes`;
  return `The learner is back — the lesson was paused for ${gap} and the conversation never ended. Continue exactly where you left off. Do not greet them again, do not re-introduce yourself, and do not repeat an item you have already taught unless they ask.`;
}

export const TUTOR_HEARTBEAT_MS = 1_000;

export const MIN_TURN_TIMEOUT_SECONDS = 3;
