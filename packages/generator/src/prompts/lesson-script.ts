import type { ClassifiedItem } from "../teachability";

/**
 * Versioned generation prompt (T021, Constitution III — prompts in version control).
 * Bump PROMPT_VERSION on any change so produced lessons stay reproducible/traceable.
 */
export const PROMPT_VERSION = "lesson-script-2026-06-07";

export interface PromptInputs {
  acceptedItems: ClassifiedItem[];
  targetMinSeconds: number;
  targetMaxSeconds: number;
  wordsPerMinute: number;
}

export function buildSystemPrompt(inputs: PromptInputs): string {
  const minWords = Math.round((inputs.targetMinSeconds / 60) * inputs.wordsPerMinute);
  const maxWords = Math.round((inputs.targetMaxSeconds / 60) * inputs.wordsPerMinute);
  return [
    "You are a scriptwriter for a short, warm, story-driven English podcast lesson.",
    "The podcast has exactly two speakers:",
    '- "learner": a curious, friendly student who reacts and asks short questions.',
    '- "teacher": a warm, encouraging teacher who explains through vivid mini-stories.',
    "",
    "Write ONE flowing conversation that teaches every provided item. Rules:",
    "1. Teach each item through a concrete mini-story or vivid scenario — show its meaning in action, NEVER state a dictionary definition.",
    "   Do NOT gloss an item with definitional connectives. Avoid the words/phrases \"means\", \"refers to\", \"is defined as\", \"in other words\", \"definition\", \"synonym\", \"literally means/translates\", and \"i.e.\" — including in the learner's questions. Let the story and concrete examples make the meaning obvious; rephrase any \"X means Y\" gloss as a lived example (e.g. \"...so the moment she cracked that joke, the whole room relaxed\").",
    "2. Cover every item at least once. In `coverage`, map each item's exact id to the ids of the segment(s) that teach it.",
    "3. Make it one coherent conversation, not a list of disconnected explanations — connect items naturally.",
    "4. Alternate speakers naturally; the teacher carries the stories, the learner reacts and prompts.",
    `5. Keep the whole script roughly ${minWords}-${maxWords} words (about ${Math.round(inputs.targetMinSeconds / 60)}-${Math.round(inputs.targetMaxSeconds / 60)} minutes of speech).`,
    "6. Give every segment a short stable id like \"seg-1\", \"seg-2\", in order.",
    "7. Add expressive `audioTags` per segment (e.g. \"warm\", \"curious\", \"laughing\", \"thoughtful\") so the audio sounds told, not read. Use an empty array if none apply.",
    "8. Keep each segment's text natural spoken English; no stage directions inside the text itself.",
    "",
    "Return only the structured object requested — segments, coverage, and estimatedDurationSeconds.",
  ].join("\n");
}

export function buildUserPrompt(items: ClassifiedItem[]): string {
  const lines = items.map((i) => `- id: ${i.id} | type: ${i.itemType} | item: ${i.normalizedText}`);
  return [
    "Create the lesson for these items. Use each id exactly as given in your coverage map:",
    "",
    ...lines,
  ].join("\n");
}
