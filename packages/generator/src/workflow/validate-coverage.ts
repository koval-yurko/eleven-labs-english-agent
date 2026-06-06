import type { LessonScript } from "@idiomatic/contracts";

/**
 * Coverage validation (research R2) — turns FR-009/SC-002 ("every accepted item is
 * taught at least once") into a machine-checkable invariant. Verified in code, not
 * trusted to the model. The workflow re-prompts for any uncovered items before a
 * script is accepted and the lesson flips to `ready`.
 */

export interface CoverageValidation {
  ok: boolean;
  /** sourceItemIds with no covering segment, or covered by a non-existent segment. */
  uncovered: string[];
  /** coverage entries that reference segmentIds not present in the script. */
  danglingSegmentRefs: string[];
}

export function validateCoverage(
  acceptedItemIds: readonly string[],
  script: LessonScript,
): CoverageValidation {
  const segmentIds = new Set(script.segments.map((s) => s.id));

  // Map each item -> set of valid (existing) segments that teach it.
  const coveredBy = new Map<string, Set<string>>();
  const danglingSegmentRefs: string[] = [];

  for (const entry of script.coverage) {
    const valid = new Set<string>();
    for (const segId of entry.segmentIds) {
      if (segmentIds.has(segId)) {
        valid.add(segId);
      } else {
        danglingSegmentRefs.push(segId);
      }
    }
    if (valid.size > 0) {
      const existing = coveredBy.get(entry.sourceItemId) ?? new Set<string>();
      for (const v of valid) existing.add(v);
      coveredBy.set(entry.sourceItemId, existing);
    }
  }

  const uncovered = acceptedItemIds.filter((id) => {
    const segs = coveredBy.get(id);
    return segs === undefined || segs.size === 0;
  });

  return {
    ok: uncovered.length === 0,
    uncovered,
    danglingSegmentRefs,
  };
}
