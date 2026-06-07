import type { LessonScript } from "@idiomatic/contracts";

/**
 * Resolve the lesson item "active" at a playback position (research R3). Runs
 * SERVER-SIDE (the client only ever sends a position): the live-session route uses it
 * to ground the agent in the current item, and QaService uses it to anchor a captured
 * exchange to a source item (FR-012).
 *
 * Approach: distribute the lesson's duration across script segments proportional to each
 * segment's text length to get per-segment start offsets, take each covered item's
 * earliest teaching segment as that item's start, then pick the most-recently-started
 * item at the given position (boundary/gap → most recent; before the first → null).
 * Isolated here so it can later be replaced by precise persisted timings (R3) without
 * touching callers.
 */

export interface ItemTimelineEntry {
  startSeconds: number;
  sourceItemId: string;
  normalizedText: string;
}

interface ItemLite {
  id: string;
  normalizedText: string;
  teachable: boolean;
}

export function buildItemTimeline(
  script: LessonScript,
  items: ItemLite[],
  totalDurationSeconds?: number | null,
): ItemTimelineEntry[] {
  const total =
    totalDurationSeconds && totalDurationSeconds > 0
      ? totalDurationSeconds
      : script.estimatedDurationSeconds;
  const totalChars = script.segments.reduce((sum, seg) => sum + seg.text.length, 0) || 1;

  // Per-segment start offset (seconds), char-proportional and in script order.
  const segmentStart = new Map<string, number>();
  let cumulativeChars = 0;
  for (const seg of script.segments) {
    segmentStart.set(seg.id, (cumulativeChars / totalChars) * total);
    cumulativeChars += seg.text.length;
  }

  // Coverage references items by normalizedText; map that to the persisted item id.
  const idByNormalized = new Map<string, string>();
  for (const item of items) {
    if (item.teachable) idByNormalized.set(item.normalizedText, item.id);
  }

  const entries: ItemTimelineEntry[] = [];
  for (const cov of script.coverage) {
    const sourceItemId = idByNormalized.get(cov.normalizedText);
    if (!sourceItemId) continue; // item not found among teachable rows — skip
    const starts = cov.segmentIds
      .map((sid) => segmentStart.get(sid))
      .filter((v): v is number => v !== undefined);
    if (starts.length === 0) continue;
    entries.push({ startSeconds: Math.min(...starts), sourceItemId, normalizedText: cov.normalizedText });
  }

  entries.sort((a, b) => a.startSeconds - b.startSeconds);
  return entries;
}

/** The most-recently-started item at `positionSeconds`, or null if before the first item. */
export function resolveItemAtPosition(
  timeline: ItemTimelineEntry[],
  positionSeconds: number,
): ItemTimelineEntry | null {
  let current: ItemTimelineEntry | null = null;
  for (const entry of timeline) {
    if (entry.startSeconds <= positionSeconds) current = entry;
    else break;
  }
  return current;
}
