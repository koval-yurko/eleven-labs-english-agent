import type { LessonScript } from "@idiomatic/contracts";
import { validateCoverage } from "../workflow/validate-coverage";

/**
 * Generation-quality scorers (T051, Constitution III). Each turns one quality bar from
 * the spec into a machine-checkable score over a generated LessonScript + its rendered
 * audio. They are pure so they run identically in the `pnpm eval:generation` gate, in the
 * CI scorer test (against mocks), and — when keys are present — against live output.
 */

export interface ScoreResult {
  key: ScorerKey;
  pass: boolean;
  /** 0..1 quality score for trend tracking / LangSmith upload. */
  score: number;
  detail: string;
}

export type ScorerKey = "coverage" | "two_voice" | "story_not_definition" | "length";

export interface LengthWindow {
  minSeconds: number;
  maxSeconds: number;
}

/** Dictionary-definition phrasing the lesson must avoid — it should teach via story (FR-008). */
const DEFINITION_PATTERNS: RegExp[] = [
  /\bmeans\b/i,
  /\bis defined as\b/i,
  /\bdefinition\b/i,
  /\brefers to\b/i,
  /\bin other words\b/i,
  /\bsynonym(?:ous)?\b/i,
  /\bliterally\s+(?:means|translates)\b/i,
  /\bi\.e\.\b/i,
];

/** FR-009/SC-002 — every accepted item is taught by at least one real segment. */
export function scoreCoverage(acceptedItemIds: readonly string[], script: LessonScript): ScoreResult {
  const result = validateCoverage(acceptedItemIds, script);
  const total = acceptedItemIds.length || 1;
  const covered = total - result.uncovered.length;
  return {
    key: "coverage",
    pass: result.ok && result.danglingSegmentRefs.length === 0,
    score: covered / total,
    detail: result.ok
      ? result.danglingSegmentRefs.length === 0
        ? `all ${acceptedItemIds.length} item(s) covered`
        : `covered, but ${result.danglingSegmentRefs.length} dangling segment ref(s)`
      : `uncovered: ${result.uncovered.join(", ")}`,
  };
}

/** SC-004 — two clearly distinct voices, and both actually speak. */
export function scoreTwoVoice(script: LessonScript): ScoreResult {
  const { learner, teacher } = script.speakers;
  const distinct = learner.voiceId !== teacher.voiceId;
  const speakers = new Set(script.segments.map((s) => s.speaker));
  const bothSpeak = speakers.has("learner") && speakers.has("teacher");
  const pass = distinct && bothSpeak;
  return {
    key: "two_voice",
    pass,
    score: pass ? 1 : 0,
    detail: !distinct
      ? "learner and teacher share a voiceId"
      : !bothSpeak
        ? `only these speakers appear: ${[...speakers].join(", ") || "none"}`
        : "two distinct voices, both speaking",
  };
}

/** FR-008 — items are taught through stories, not dictionary definitions. */
export function scoreStoryNotDefinition(
  acceptedItemIds: readonly string[],
  script: LessonScript,
): ScoreResult {
  const segmentText = new Map(script.segments.map((s) => [s.id, s.text]));
  const offenders: string[] = [];

  for (const entry of script.coverage) {
    if (!acceptedItemIds.includes(entry.sourceItemId)) continue;
    const teaching = entry.segmentIds.map((id) => segmentText.get(id) ?? "").join(" ");
    if (DEFINITION_PATTERNS.some((re) => re.test(teaching))) {
      offenders.push(entry.normalizedText);
    }
  }

  const total = acceptedItemIds.length || 1;
  const clean = total - offenders.length;
  return {
    key: "story_not_definition",
    pass: offenders.length === 0,
    score: clean / total,
    detail:
      offenders.length === 0
        ? "no definitional phrasing in teaching segments"
        : `definitional phrasing teaching: ${offenders.join(", ")}`,
  };
}

/** FR-012/SC-003 — the lesson lands inside the target length window. */
export function scoreLength(durationSeconds: number, window: LengthWindow): ScoreResult {
  const { minSeconds, maxSeconds } = window;
  const pass = durationSeconds >= minSeconds && durationSeconds <= maxSeconds;
  let score = 1;
  if (durationSeconds < minSeconds) score = durationSeconds / minSeconds;
  else if (durationSeconds > maxSeconds) score = maxSeconds / durationSeconds;
  return {
    key: "length",
    pass,
    score: Math.max(0, Math.min(1, score)),
    detail: `${durationSeconds}s vs target ${minSeconds}-${maxSeconds}s`,
  };
}
