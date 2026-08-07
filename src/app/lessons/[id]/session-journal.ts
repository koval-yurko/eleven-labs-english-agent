"use client";

import { getDb, type SessionJournalEntry } from "../../../lib/sync/db";
import type { TranscriptLine } from "../../../lib/tutor";

/**
 * Crash-safety for a live tutor session: every transcript line is written to the IndexedDB mirror
 * as it arrives, and flushed to the server with `sendBeacon` when iOS is about to freeze or discard
 * the page. Without this, a tab discarded under memory pressure — or a hard suspend where
 * `onDisconnect` never gets to run — loses everything said so far, and the lesson only reappears if
 * the post-call webhook lands.
 *
 * Browser-only (Dexie + `navigator.sendBeacon`); call from effects and event handlers.
 * See docs/2026-08-07-ios-keep-session-alive-foreground.md.
 */

export type { SessionJournalEntry };

/** The beacon endpoint — a plain POST twin of `saveLessonSessionAction`, callable from `pagehide`. */
const BEACON_URL = "/api/lessons/session";

export async function writeJournal(entry: Omit<SessionJournalEntry, "updatedAt">): Promise<void> {
  try {
    await getDb().sessionJournal.put({ ...entry, updatedAt: new Date().toISOString() });
  } catch {
    // Best effort — a journal write must never break a running conversation.
  }
}

export async function readJournal(lessonId: string): Promise<SessionJournalEntry | null> {
  try {
    return (await getDb().sessionJournal.get(lessonId)) ?? null;
  } catch {
    return null;
  }
}

export async function clearJournal(lessonId: string): Promise<void> {
  try {
    await getDb().sessionJournal.delete(lessonId);
  } catch {
    // Ignored: a stale journal is offered as "continue where you left off", never replayed blindly.
  }
}

/**
 * Ship the transcript from inside `pagehide` / `freeze`, where `fetch` is unreliable but a beacon
 * is queued by the browser and survives the page going away. Cookies ride along (same origin), so
 * the route authenticates exactly like the server action does.
 */
export function beaconJournal(entry: {
  lessonId: string;
  conversationId: string | null;
  agentVersion: string;
  lines: TranscriptLine[];
}): boolean {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return false;
  if (!entry.conversationId || entry.lines.length === 0) return false;
  try {
    const body = new Blob([JSON.stringify(entry)], { type: "application/json" });
    return navigator.sendBeacon(BEACON_URL, body);
  } catch {
    return false;
  }
}
