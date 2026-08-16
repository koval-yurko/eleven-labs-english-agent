import Storage from "expo-sqlite/kv-store";
import type { SessionJournalEntry } from "@tutor/shared/mirror-store";
import type { TranscriptLine } from "@tutor/shared/tutor";

/**
 * Crash insurance for a live tutor session: every transcript line is written to the device as it
 * arrives, and cleared once the server has the conversation.
 *
 * **Its job is not the web journal's job.** There, it catches a tab iOS discarded mid-sentence —
 * routine, and the reason `beaconJournal` exists. Here there is no page teardown to outrun: the app
 * holds an audio background mode and survives backgrounding (S1). What is left is a crash or a
 * force-quit, which is rare and real, and ends the same way — a transcript on the device and no row
 * on the server. So the recovery flow ports unchanged and the copy tells the truth: "your last
 * session ended unexpectedly" now describes something unexpected.
 *
 * `expo-sqlite/kv-store` rather than a table: the entry is one JSON blob per lesson, rewritten whole,
 * with no queries over it. It is first-party (tracks the SDK), AsyncStorage-shaped, and the same
 * package the deferred SQLite mirror (D1) will need — so the journal moves in as one more table on
 * that day instead of being migrated off a fourth-party store.
 *
 * `expo-sqlite`'s config plugin is deliberately NOT in `app.config.ts`: read it (`plugin/build/
 * withSQLite.js`) and every branch is `if (value !== undefined)` — with no props it writes nothing.
 * The native module autolinks regardless. `expo install` suggests adding it anyway; that suggestion
 * is generic, not specific to this use.
 *
 * See docs/2026-08-13-expo-s4-tutor-screen.md D35.
 */

export type { SessionJournalEntry };

const key = (lessonId: string) => `journal:${lessonId}`;

/**
 * Every function here swallows its errors, and that is the design: a journal write happens on the
 * hot path of a running conversation (once per transcript line), and storage failing is not a reason
 * for the lesson to stop. The journal is insurance — insurance that breaks the thing it insures is
 * worse than no insurance.
 */
export async function writeJournal(
  entry: Omit<SessionJournalEntry, "updatedAt">,
  now: Date = new Date(),
): Promise<void> {
  try {
    const full: SessionJournalEntry = { ...entry, updatedAt: now.toISOString() };
    await Storage.setItem(key(entry.lessonId), JSON.stringify(full));
  } catch {
    // Best effort — never break a running conversation.
  }
}

export async function readJournal(lessonId: string): Promise<SessionJournalEntry | null> {
  try {
    const raw = await Storage.getItem(key(lessonId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // A journal is replayed as CONTEXT and offered to the learner, never trusted as a record — but a
    // half-written blob would crash the screen it is supposed to rescue, so check the shape.
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as Partial<SessionJournalEntry>;
    if (typeof entry.lessonId !== "string" || !Array.isArray(entry.lines)) return null;
    return entry as SessionJournalEntry;
  } catch {
    return null;
  }
}

export async function clearJournal(lessonId: string): Promise<void> {
  try {
    await Storage.removeItem(key(lessonId));
  } catch {
    // Ignored: a stale journal is offered as "continue where you left off", never replayed blindly.
  }
}

// ── the pause marker ─────────────────────────────────────────────────────────────────────────

/**
 * A lesson the learner PAUSED, parked on the device so the pause survives leaving the screen and
 * restarting the app.
 *
 * Separate from the journal rather than a flag on it, because the two mean opposite things: a
 * journal is a transcript the SERVER MAY NOT HAVE (insurance, cleared the moment it does), while a
 * marker is a transcript the server already took and the learner intends to continue. Folding them
 * together would make "clear the journal after saving" — the one line that keeps the recovery card
 * honest — also throw away the pause.
 *
 * It carries its own `lines` instead of reading them back from `LessonDetailResponse.sessions`: the
 * restore then needs no network and no ordering assumption about which fetch lands first, and it
 * still works when the save that preceded the pause failed.
 *
 * See docs/2026-08-16-tutor-session-pause-resume.md §4.3.
 */
export interface PausedSessionEntry {
  lessonId: string;
  /** The conversation that was paused — already saved under this id, or about to be. */
  conversationId: string | null;
  agentVersion: string;
  lines: TranscriptLine[];
  pausedAt: string;
}

const pauseKey = (lessonId: string) => `paused:${lessonId}`;

/** Best-effort like the journal: failing to park a pause must never break ending the session. */
export async function writePauseMarker(
  entry: Omit<PausedSessionEntry, "pausedAt">,
  now: Date = new Date(),
): Promise<void> {
  try {
    const full: PausedSessionEntry = { ...entry, pausedAt: now.toISOString() };
    await Storage.setItem(pauseKey(entry.lessonId), JSON.stringify(full));
  } catch {
    // The pause still works in memory for as long as the screen lives.
  }
}

export async function readPauseMarker(lessonId: string): Promise<PausedSessionEntry | null> {
  try {
    const raw = await Storage.getItem(pauseKey(lessonId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as Partial<PausedSessionEntry>;
    if (typeof entry.lessonId !== "string" || !Array.isArray(entry.lines)) return null;
    if (typeof entry.pausedAt !== "string") return null;
    return entry as PausedSessionEntry;
  } catch {
    return null;
  }
}

export async function clearPauseMarker(lessonId: string): Promise<void> {
  try {
    await Storage.removeItem(pauseKey(lessonId));
  } catch {
    // A stale marker only ever offers a resume the learner can decline.
  }
}
