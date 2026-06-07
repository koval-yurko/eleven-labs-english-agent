import type { LessonScript } from "@idiomatic/contracts";
import { LessonScript as LessonScriptSchema } from "@idiomatic/contracts";
import type { GeneratorConfig } from "./config";
import type { ClassifiedItem } from "./teachability";
import type { LlmAdapter } from "./adapters/types";
import { validateCoverage } from "./workflow/validate-coverage";
import { noopLogger, type Logger } from "./observability";

export * from "./config";
export * from "./teachability";
export * from "./submission";
export * from "./workflow/validate-coverage";
export * from "./workflow/derive-plan";
export * from "./workflow/tracing";
export * from "./adapters/types";
export * from "./adapters/mock";
export * from "./adapters/claude";
export * from "./prompts/lesson-script";
export * from "./observability";
export * from "./utils/concurrency";

export interface GenerateLessonDeps {
  llm: LlmAdapter;
  config: GeneratorConfig;
  /**
   * Optional per-run logger (003-internal-logging). The web bridge injects a child logger
   * bound to `{ lessonId, ownerId }`; defaults to a no-op so existing callers/tests are
   * unaffected and the generator stays decoupled.
   */
  logger?: Logger;
}

export interface GenerationMetadata {
  modelId: string;
  promptVersion: string;
  acceptedItemIds: string[];
}

export interface GenerateLessonResult {
  script: LessonScript;
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
 * Pipeline: draft (LLM) -> validate coverage (re-prompt on miss, research R2).
 * Returns the structured script and the reproducibility metadata persisted with every
 * lesson (Constitution III); a lesson is ready once it has a valid script (FR-004, 007).
 */
export async function generateLesson(
  acceptedItems: ClassifiedItem[],
  deps: GenerateLessonDeps,
): Promise<GenerateLessonResult> {
  if (acceptedItems.length === 0) {
    throw new Error("generateLesson requires at least one accepted item");
  }

  const { llm, config } = deps;
  const log = deps.logger ?? noopLogger;
  const acceptedItemIds = acceptedItems.map((i) => i.id);

  let script: LessonScript | null = null;
  for (let attempt = 1; attempt <= MAX_COVERAGE_ATTEMPTS; attempt++) {
    const reprompted = attempt > 1;
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

    log.info("generate.draft", `draft attempt ${attempt}/${MAX_COVERAGE_ATTEMPTS}`, {
      attempt,
      maxAttempts: MAX_COVERAGE_ATTEMPTS,
      outcome: coverage.ok ? "covered" : "uncovered",
      segments: parsed.segments.length,
      // Raw draft body is privacy-sensitive — debug only (FR-017).
      ...(log.enabled("debug") ? { body: parsed } : {}),
    });
    log[coverage.ok ? "info" : "warn"]("generate.coverage", "coverage validation", {
      ok: coverage.ok,
      uncovered: coverage.uncovered,
      reprompted,
    });

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

  log.info("generate.result", "lesson generated", {
    itemCount: acceptedItemIds.length,
    modelId: llm.modelId,
    promptVersion: llm.promptVersion,
    segments: script.segments.length,
    coverage: script.coverage.length,
  });

  return {
    script,
    metadata: {
      modelId: llm.modelId,
      promptVersion: llm.promptVersion,
      acceptedItemIds,
    },
  };
}
