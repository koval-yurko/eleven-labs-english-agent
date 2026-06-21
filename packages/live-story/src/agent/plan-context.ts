import type { LessonPlan } from "@idiomatic/contracts";

/**
 * Map a derived `LessonPlan` → the per-session dynamic variables that ground the narrator
 * agent (research R1/R2). Injected at `startSession`; keys match the `{{...}}` placeholders
 * in agent-prompt.ts. Also exposes the scenario-pin text re-sent every beat / on a scenario
 * change via `sendContextualUpdate` (R4). All values are strings (the SDK's dynamic-variable
 * contract).
 */

const ORIGINAL_SCENARIO_LABEL = "the lesson's original everyday setting";

export function buildPlanDynamicVariables(
  plan: LessonPlan,
  scenario: string | null = null,
): Record<string, string> {
  const itemsList = plan.items.map((i, idx) => `${idx + 1}. ${i.normalizedText}`).join("; ");
  const beatsOutline = plan.beats
    .map((b) => {
      const teaches = b.teachesItemIds
        .map((id) => plan.items.find((i) => i.sourceItemId === id)?.normalizedText)
        .filter((t): t is string => Boolean(t));
      const teachClause = teaches.length > 0 ? ` (teaches: ${teaches.join(", ")})` : "";
      return `${b.index + 1}. ${b.summary}${teachClause}`;
    })
    .join("\n");
  const targetMinutes = String(Math.max(1, Math.round(plan.targetSeconds / 60)));

  return {
    lesson_summary: `A short spoken English lesson told as a story, teaching ${plan.items.length} item(s) across ${plan.beats.length} beat(s).`,
    items_list: itemsList.length > 0 ? itemsList : "(no items)",
    beats_outline: beatsOutline.length > 0 ? beatsOutline : "(no beats)",
    target_minutes: targetMinutes,
    scenario: scenario && scenario.trim().length > 0 ? scenario : ORIGINAL_SCENARIO_LABEL,
  };
}

/** The steering text re-pinned every beat and on a scenario change (R4). */
export function scenarioPinText(scenario: string | null): string {
  if (!scenario || scenario.trim().length === 0) {
    return `Continue the story in ${ORIGINAL_SCENARIO_LABEL}.`;
  }
  return `From now on the story is set in: ${scenario}. Continue teaching the remaining items in this setting.`;
}
