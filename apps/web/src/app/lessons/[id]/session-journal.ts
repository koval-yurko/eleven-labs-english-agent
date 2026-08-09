"use client";

import { getStore } from "../../../lib/sync/dexie-store";
import type { SessionJournalEntry } from "@tutor/shared/mirror-store";
import { sanitizeTranscript, type TranscriptLine } from "@tutor/shared/tutor";
import { API_ROUTES } from "@tutor/shared/api";

/**
 * Crash-safety for a live tutor session: every transcript line is written to the IndexedDB mirror
 * as it arrives, and flushed to the server with `sendBeacon` when iOS is about to freeze or discard
 * the page. Without this, a tab discarded under memory pressure — or a hard suspend where
 * `onDisconnect` never gets to run — loses everything said so far, and the lesson only reappears if
 * the post-call webhook lands.
 *
 * Storage goes through the mirror store's `journal` (`src/shared/mirror-store.ts`); the beacon is
 * browser-only (`navigator.sendBeacon`). Call from effects and event handlers.
 * See docs/2026-08-07-ios-keep-session-alive-foreground.md.
 */

export type { SessionJournalEntry };

/** The beacon endpoint — a plain POST twin of `saveLessonSessionAction`, callable from `pagehide`. */
const BEACON_URL = API_ROUTES.lessonSession;

export async function writeJournal(entry: Omit<SessionJournalEntry, "updatedAt">): Promise<void> {
  try {
    await getStore().journal.put({ ...entry, updatedAt: new Date().toISOString() });
  } catch {
    // Best effort — a journal write must never break a running conversation.
  }
}

export async function readJournal(lessonId: string): Promise<SessionJournalEntry | null> {
  try {
    return await getStore().journal.get(lessonId);
  } catch {
    return null;
  }
}

export async function clearJournal(lessonId: string): Promise<void> {
  try {
    await getStore().journal.delete(lessonId);
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
    // Trim to exactly what the server will store before sending: `sendBeacon` has a payload
    // ceiling (and this fires on a possibly-cellular link during page teardown), so shipping
    // lines the server would only discard risks losing the whole beacon.
    const lines = sanitizeTranscript(entry.lines);
    if (lines.length === 0) return false;
    const body = new Blob([JSON.stringify({ ...entry, lines })], { type: "application/json" });
    return navigator.sendBeacon(BEACON_URL, body);
  } catch {
    return false;
  }
}
