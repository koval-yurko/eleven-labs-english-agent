import Storage from "expo-sqlite/kv-store";
import type { SessionJournalEntry } from "@tutor/shared/mirror-store";

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
