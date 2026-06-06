/**
 * Generation eval dataset (T051). Small, representative list-inputs that exercise the
 * quality bars: single item, a handful of idioms, and a mixed word/idiom/sentence set.
 * Kept in version control alongside the prompts so eval runs are reproducible.
 */

export interface EvalCase {
  /** Stable id, used as the LangSmith example key when uploading. */
  id: string;
  description: string;
  input: string[];
}

export const EVAL_DATASET: EvalCase[] = [
  {
    id: "single-idiom",
    description: "A single idiom must still become a coherent two-voice lesson.",
    input: ["break the ice"],
  },
  {
    id: "idiom-set",
    description: "A handful of idioms, each taught via its own mini-story.",
    input: ["spill the beans", "under the weather", "piece of cake", "hit the books"],
  },
  {
    id: "mixed-types",
    description: "Mixed word / idiom / sentence input.",
    input: ["resilient", "bite the bullet", "Could you repeat that more slowly?"],
  },
];
