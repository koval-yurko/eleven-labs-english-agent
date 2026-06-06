import type { LessonScript } from "@idiomatic/contracts";
import { LessonScript as LessonScriptSchema } from "@idiomatic/contracts";
import type { GeneratorConfig } from "./config";
import type { ClassifiedItem } from "./teachability";
import type { LlmAdapter, RenderedAudio, TtsAdapter } from "./adapters/types";
import { validateCoverage } from "./workflow/validate-coverage";

export * from "./config";
export * from "./teachability";
export * from "./submission";
export * from "./workflow/validate-coverage";
export * from "./adapters/types";
export * from "./adapters/mock";

export interface GenerateLessonDeps {
  llm: LlmAdapter;
  tts: TtsAdapter;
  config: GeneratorConfig;
}

export interface GenerationMetadata {
  modelId: string;
  promptVersion: string;
  acceptedItemIds: string[];
}

export interface GenerateLessonResult {
  script: LessonScript;
  audio: RenderedAudio;
  metadata: GenerationMetadata;
}

export class CoverageError extends Error {
  constructor(public readonly uncovered: string[]) {
    super(`Generated script failed coverage validation; uncovered items: ${uncovered.join(", ")}`);
    this.name = "CoverageError";
  }
}

const MAX_COVERAGE_ATTEMPTS = 2;

/**
 * Generate a lesson from already-classified, accepted items (research R8).
 * Pipeline: draft (LLM) -> validate coverage (re-prompt on miss, research R2) ->
 * render + measure (TTS, research R5). Returns the script, stitched audio, and the
 * reproducibility metadata persisted with every lesson (Constitution III).
 */
export async function generateLesson(
  acceptedItems: ClassifiedItem[],
  deps: GenerateLessonDeps,
): Promise<GenerateLessonResult> {
  if (acceptedItems.length === 0) {
    throw new Error("generateLesson requires at least one accepted item");
  }

  const { llm, tts, config } = deps;
  const acceptedItemIds = acceptedItems.map((i) => i.id);

  let script: LessonScript | null = null;
  for (let attempt = 1; attempt <= MAX_COVERAGE_ATTEMPTS; attempt++) {
    const draft = await llm.draftScript({
      acceptedItems,
      teacherVoiceId: config.teacherVoiceId,
      learnerVoiceId: config.learnerVoiceId,
      targetMinSeconds: config.targetMinSeconds,
      targetMaxSeconds: config.targetMaxSeconds,
      wordsPerMinute: config.wordsPerMinute,
    });

    // Structural validation against the shared contract before we trust the draft.
    const parsed = LessonScriptSchema.parse(draft);
    const coverage = validateCoverage(acceptedItemIds, parsed);
    if (coverage.ok) {
      script = parsed;
      break;
    }
    if (attempt === MAX_COVERAGE_ATTEMPTS) {
      throw new CoverageError(coverage.uncovered);
    }
  }

  // Unreachable, but keeps the type non-null.
  if (script === null) {
    throw new CoverageError(acceptedItemIds);
  }

  const audio = await tts.renderDialogue(script, config.ttsCharLimit);

  return {
    script,
    audio,
    metadata: {
      modelId: llm.modelId,
      promptVersion: llm.promptVersion,
      acceptedItemIds,
    },
  };
}
