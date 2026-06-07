import type { LessonPlan, LessonScript, PlanBeat, PlanItem } from "@idiomatic/contracts";

/**
 * Derive the in-memory `LessonPlan` that drives live narration (006-adaptive-live-story,
 * research R2) — PURE and READ-ONLY over the persisted `LessonScript` + `source_items`
 * (the agreed subsystem boundary). No batch-generation behavior changes, so the generation
 * eval gate cannot regress (Constitution III). Isolated here so it stays unit-testable and
 * can later be replaced by a dedicated `planLesson` flow without changing callers.
 *
 * The plan = ordered teachable items + story beats (condensed from `script.segments`,
 * grouped by which item(s) they teach) + a bounded target length (`estimatedDurationSeconds`
 * clamped to the configured window, R8). Coverage is then enforced at narration time by the
 * state machine (R3); this asserts only the plan-time coverage mirror (every item appears in
 * some beat) — the same failure class `validateCoverage` already guards at generation time.
 */

/** Minimal source-item shape `derivePlan` needs (decoupled from the web persistence record). */
export interface PlanSourceItem {
  id: string;
  normalizedText: string;
  itemType: PlanItem["itemType"];
  teachable: boolean;
  orderIndex: number;
}

export interface DerivePlanConfig {
  targetMinSeconds: number;
  targetMaxSeconds: number;
}

const SUMMARY_MAX_CHARS = 140;

export function derivePlan(
  script: LessonScript,
  items: PlanSourceItem[],
  config: DerivePlanConfig,
): LessonPlan {
  // 1. Items: teachable, ordered by orderIndex.
  const orderedItems = items
    .filter((i) => i.teachable)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const planItems: PlanItem[] = orderedItems.map((i) => ({
    sourceItemId: i.id,
    normalizedText: i.normalizedText,
    itemType: i.itemType,
  }));

  if (planItems.length === 0) {
    throw new Error("derivePlan: a ready lesson must have at least one teachable item");
  }

  // Resolve coverage -> persisted item id by normalizedText (coverage references items by
  // normalizedText; the persisted source_items hold the authoritative ids — same mapping as
  // live-tutor/current-item.ts). This guarantees beat.teachesItemIds match PlanItem.sourceItemId.
  const idByNormalized = new Map<string, string>();
  for (const i of orderedItems) idByNormalized.set(i.normalizedText, i.id);

  const itemIdBySegment = new Map<string, string>();
  for (const cov of script.coverage) {
    const itemId = idByNormalized.get(cov.normalizedText);
    if (!itemId) continue; // coverage entry for a non-teachable / removed item — skip
    for (const segId of cov.segmentIds) itemIdBySegment.set(segId, itemId);
  }

  // 2. Beats: walk segments in order, grouping consecutive segments. Open a new beat when
  // the current beat already teaches an item and the next segment teaches a DIFFERENT item.
  const beats: PlanBeat[] = [];
  let currentSegments: string[] = [];
  let currentTeaches: string[] = [];

  const flush = (): void => {
    if (currentSegments.length === 0) return;
    beats.push({
      index: beats.length,
      summary: summarize(currentSegments),
      teachesItemIds: [...currentTeaches],
    });
    currentSegments = [];
    currentTeaches = [];
  };

  for (const seg of script.segments) {
    const itemId = itemIdBySegment.get(seg.id);
    const startsNewFocus =
      itemId !== undefined && currentTeaches.length > 0 && !currentTeaches.includes(itemId);
    if (startsNewFocus) flush();
    currentSegments.push(seg.text);
    if (itemId !== undefined && !currentTeaches.includes(itemId)) currentTeaches.push(itemId);
  }
  flush();

  if (beats.length === 0) {
    throw new Error("derivePlan: script has no segments to narrate");
  }

  // 4. Coverage mirror: every teachable item must appear in some beat's teachesItemIds.
  const taught = new Set(beats.flatMap((b) => b.teachesItemIds));
  const uncovered = planItems.filter((i) => !taught.has(i.sourceItemId));
  if (uncovered.length > 0) {
    throw new Error(
      `derivePlan: malformed script — items not taught by any beat: ${uncovered
        .map((i) => i.normalizedText)
        .join(", ")}`,
    );
  }

  // 3. Target: clamp the script estimate to the configured window (R8).
  const targetSeconds = clamp(
    script.estimatedDurationSeconds,
    config.targetMinSeconds,
    config.targetMaxSeconds,
  );

  return {
    lessonId: "", // stamped by the caller (the service knows the lesson id)
    items: planItems,
    beats,
    targetSeconds: Math.max(1, targetSeconds),
    teacherVoiceId: script.speakers.teacher.voiceId,
  };
}

function summarize(segmentTexts: string[]): string {
  const joined = segmentTexts.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length <= SUMMARY_MAX_CHARS) return joined || "(beat)";
  return `${joined.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

function clamp(value: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.min(Math.max(value, lo), hi);
}
