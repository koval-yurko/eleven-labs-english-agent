import type { LessonScript } from "@idiomatic/contracts";

/**
 * Build the per-session dynamic variables that ground the live-tutor agent in this
 * lesson (research R4). Injected at startSession and refreshed via sendContextualUpdate
 * when the active item changes. Keys match the {{...}} placeholders in agent-prompt.ts.
 */

interface ItemLite {
  normalizedText: string;
  teachable: boolean;
}

export function buildDynamicVariables(
  _script: LessonScript,
  items: ItemLite[],
  currentItemText?: string,
): Record<string, string> {
  const teachable = items.filter((i) => i.teachable);
  const itemsList = teachable.map((i, idx) => `${idx + 1}. ${i.normalizedText}`).join("; ");
  return {
    lesson_summary: `A short English lesson taught as a two-voice story, teaching ${teachable.length} item(s).`,
    items_list: itemsList.length > 0 ? itemsList : "(no items)",
    current_item: currentItemText && currentItemText.length > 0 ? currentItemText : "the lesson introduction",
  };
}
