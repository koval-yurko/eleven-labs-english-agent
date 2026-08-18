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
 * conversation either way (docs/2026-08-16-tutor-session-pause-resume.md §3), so the only thing
 * that distinguishes "the phone locked" from "I stepped away" is what we tell the tutor. Saying
 * "we got cut off" to someone who pressed Pause is a small lie the tutor would then speak aloud.
 */
export const PAUSE_RESUME_MESSAGE =
  "I'm back. Pick up exactly where we stopped — one short sentence to re-orient me, then continue.";

/**
 * Hidden user turn sent the instant a held pause lands ON A TUTOR THAT IS SPEAKING — the barge-in
 * that ends the turn.
 *
 * The platform has no abort: the client→server protocol carries exactly `pong`, `feedback`,
 * `contextual_update`, `user_message`, `user_activity`, `client_tool_result`,
 * `mcp_tool_approval_result` and `user_audio_chunk`, and none of them says "stop". `interruption`
 * exists in the other direction only — it REPORTS an interruption, it cannot request one. So the
 * two ways to end a turn early are real speech (unavailable: a pause mutes the microphone) and
 * `user_message`, which the docs define as *"processed as user input … Triggers the same response
 * flow as spoken user input"* — i.e. it barges in exactly like speech.
 *
 * Two things follow, and the second is the reason this is worth a hidden turn:
 *   1. The learner stops paying for a monologue nobody hears. Before this, Pause silenced the
 *      speaker locally and the tutor kept teaching into the void for as long as its turn ran.
 *   2. `agent_response_correction` fires on barge-in, so the STORED TRANSCRIPT is truncated to what
 *      was actually delivered. The record and the learner's ears finally agree, which is what makes
 *      a bounded resume (below) honest rather than a guess.
 *
 * Worded as an instruction not to answer, because a barge-in normally invites a reply. The
 * heartbeat is what ultimately keeps the tutor quiet; this only has to stop the sentence.
 * See docs/2026-08-17-short-turns-and-chunked-pause.md §3 L5.
 */
export const PAUSE_STOP_MESSAGE =
  "[The learner just paused the lesson and can no longer hear you.] Stop speaking immediately. Do not answer this, do not summarise, say nothing at all.";

/**
 * Hidden user turn sent on resume when the pause CUT THE TUTOR OFF mid-sentence (PAUSE_STOP_MESSAGE
 * landed on a speaking tutor).
 *
 * Bounded on purpose: the tutor's own context now ends where the learner stopped hearing it, so the
 * only thing owed is the tail of one thought. Its predecessor asked for a recap of everything
 * "said while I was away" with no bound on what that was — and while one turn was a whole item's
 * worth of teaching, that meant re-delivering the item. That is the repetition the learner reported.
 */
export const ABORTED_RESUME_MESSAGE =
  "I'm back — you were cut off mid-sentence. Finish just that thought in a sentence or two, then carry on. Do not start the item over.";

/**
 * Hidden user turn sent on resume when a whole tutor turn played into a silenced speaker — the turn
 * that slipped past the `user_activity` heartbeat, or one the abort could not reach.
 *
 * Also bounded, and bounded by the same unit: with words-1.4 a turn is one thread of one item, so
 * "your last point" is a few sentences, not a chapter. The bound is stated as a sentence count
 * rather than as "briefly", because an adverb is a wish and a number is a budget.
 */
export const UNHEARD_RESUME_MESSAGE =
  "I'm back — I didn't hear your last point. Repeat just that one, in two or three sentences, then carry on. Do not repeat anything before it.";

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
  PAUSE_STOP_MESSAGE,
  ABORTED_RESUME_MESSAGE,
  UNHEARD_RESUME_MESSAGE,
  // The single unbounded resume message these three replaced on 2026-08-17. Kept as a literal so a
  // post-call webhook still in flight for a conversation that used it cannot write it into a stored
  // transcript as a learner turn.
  "I'm back — I didn't hear what you said while I was away. Recap that briefly, then carry on.",
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

// ── holding the line open ────────────────────────────────────────────────────────────────────

/**
 * Contextual update sent the moment a HELD pause begins — the conversation stays open, the
 * microphone is muted and a `user_activity` heartbeat keeps the turn timer from expiring.
 *
 * The heartbeat is what actually keeps the tutor quiet; this is the belt to its braces. If a turn
 * ever does slip through (a missed ping, a timer the OS throttled), the tutor at least knows WHY
 * nobody is answering, and asks nothing rather than starting an "are you still there?" spiral.
 *
 * See docs/2026-08-16-tutor-pause-hold-the-line.md §2.1.
 */
export const PAUSE_CONTEXT =
  "The learner has paused the lesson and stepped away. Their microphone is muted and they cannot hear you. Say nothing at all until they come back — do not greet, do not prompt, do not ask if they are still there.";

/**
 * Contextual update sent when a held pause is released. Non-interrupting: it does NOT make the
 * tutor speak, which is deliberate — after a short pause the learner is mid-thought and speaks
 * first. The one case where the tutor should talk is handled by SOFT_RESUME_MESSAGE instead.
 *
 * The gap is stated because "carry on as if nothing happened" is right for forty seconds and wrong
 * for six minutes — the tutor can pitch its own re-entry once it knows which it was.
 */
export function formatHeldResumeContext(pausedSeconds: number): string {
  const secs = Math.max(0, Math.round(pausedSeconds));
  const gap =
    secs < 90 ? `${secs} seconds` : `about ${Math.round(secs / 60)} minutes`;
  return `The learner is back — the lesson was paused for ${gap} and the conversation never ended. Continue exactly where you left off. Do not greet them again, do not re-introduce yourself, and do not repeat an item you have already taught unless they ask.`;
}
// ── the heartbeat contract ───────────────────────────────────────────────────────────────────

/**
 * How often a held pause pings `user_activity`, in milliseconds.
 *
 * A held pause keeps the tutor quiet by resetting `turn_timeout` — *"maximum wait time for the
 * user's reply before re-engaging the user"* — before it can fire. So this interval and the
 * `turnTimeoutSeconds` baked into the agent are ONE mechanism split across two deployments: the
 * ping runs on the phone, the timeout lives inside an ElevenLabs agent, and if the ping is ever
 * slower than the timeout a paused lesson starts teaching into a silenced speaker.
 *
 * It lived on the mobile screen as a comment reasoning about a 7-second timeout ("3 s is three
 * eighths of it") until words-1.5 took the timeout to 3 s for podcast pacing and turned that margin
 * into a race. It is here now because it is exactly the kind of agreement `packages/shared` exists
 * to hold: no deploy of either side alone can fix a mismatch.
 *
 * 1 s against the `MIN_TURN_TIMEOUT_SECONDS` floor of 3 s means a single lost ping still lands
 * inside the window (2 s < 3 s). Two consecutive losses on a live data channel mean the line is in
 * trouble, and the recovery for that is the drop path, not a faster ping.
 *
 * See docs/2026-08-18-podcast-mode-tutor.md §3.
 */
export const TUTOR_HEARTBEAT_MS = 1_000;

/**
 * The lowest `turn_timeout` any baked prompt version may pin, in seconds.
 *
 * Enforced at sync time (`effectiveConfig` throws), because the alternative is a held pause that
 * quietly stops holding — a failure nobody sees until a learner comes back from a pause to a tutor
 * that has been talking to an empty room. ElevenLabs' own accepted range starts at 1; ours starts
 * at THREE times `TUTOR_HEARTBEAT_MS`, and for a different reason: the ping has to survive losing
 * one. At twice the heartbeat a single dropped ping is already a race, which is a margin only on
 * paper — so the floor is the value words-1.5 actually pins, and going below it means lowering the
 * heartbeat first and re-doing this arithmetic, not editing this number.
 */
export const MIN_TURN_TIMEOUT_SECONDS = 3;
