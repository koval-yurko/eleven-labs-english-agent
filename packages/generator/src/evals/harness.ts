import { generateLesson, type GenerateLessonDeps } from "../index";
import { classifyInput } from "../teachability";
import type { EvalCase } from "./dataset";
import {
  scoreCoverage,
  scoreLength,
  scoreStoryNotDefinition,
  scoreTwoVoice,
  type LengthWindow,
  type ScoreResult,
} from "./scorers";

/**
 * Eval harness (T051). Runs the real generation pipeline (`generateLesson`) over each
 * dataset case and applies the quality scorers. The CLI gate (`run.ts`) and the CI scorer
 * test both call this — the only difference is the deps (live adapters vs. mocks) and which
 * scorers gate (see `gatingKeys`).
 */

export interface CaseEvaluation {
  case: EvalCase;
  acceptedItemIds: string[];
  scores: ScoreResult[];
  /** True when every *gating* scorer passed. */
  pass: boolean;
  error?: string;
}

export interface EvalOptions {
  lengthWindow: LengthWindow;
  /** Which scorers count toward pass/fail. Length is non-gating against mocks. */
  gatingKeys: ReadonlySet<ScoreResult["key"]>;
}

export const ALL_GATING: ReadonlySet<ScoreResult["key"]> = new Set([
  "coverage",
  "two_voice",
  "story_not_definition",
  "length",
]);

/** Mocks produce tiny audio, so length is reported but not gated when running on mocks. */
export const MOCK_GATING: ReadonlySet<ScoreResult["key"]> = new Set([
  "coverage",
  "two_voice",
  "story_not_definition",
]);

export async function evaluateCase(
  evalCase: EvalCase,
  deps: GenerateLessonDeps,
  options: EvalOptions,
): Promise<CaseEvaluation> {
  const { accepted } = classifyInput(evalCase.input);
  const acceptedItemIds = accepted.map((i) => i.id);

  try {
    const result = await generateLesson(accepted, deps);
    const scores: ScoreResult[] = [
      scoreCoverage(acceptedItemIds, result.script),
      scoreTwoVoice(result.script),
      scoreStoryNotDefinition(acceptedItemIds, result.script),
      scoreLength(result.audio.durationSeconds, options.lengthWindow),
    ];
    const pass = scores.filter((s) => options.gatingKeys.has(s.key)).every((s) => s.pass);
    return { case: evalCase, acceptedItemIds, scores, pass };
  } catch (err) {
    return {
      case: evalCase,
      acceptedItemIds,
      scores: [],
      pass: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function evaluateSuite(
  cases: readonly EvalCase[],
  deps: GenerateLessonDeps,
  options: EvalOptions,
): Promise<CaseEvaluation[]> {
  const out: CaseEvaluation[] = [];
  for (const c of cases) {
    out.push(await evaluateCase(c, deps, options));
  }
  return out;
}
