import { randomUUID } from "node:crypto";
import type { CaseEvaluation } from "./harness";
import { getSharedLangSmithClient } from "../observability/tracing-runtime";

/**
 * Optional LangSmith upload for eval runs (T051/T052). LangSmith is a *soft* dependency:
 * the `langsmith` SDK is imported dynamically and every call is best-effort, so the eval
 * gate and CI run fine without `LANGSMITH_API_KEY` (or even without the package installed).
 * When configured, each eval case is logged as a run with its scorer results as feedback.
 */

export interface LangSmithEnv {
  LANGSMITH_API_KEY?: string;
  LANGCHAIN_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
  LANGCHAIN_PROJECT?: string;
}

export function langSmithApiKey(env: LangSmithEnv = process.env): string | undefined {
  return env.LANGSMITH_API_KEY ?? env.LANGCHAIN_API_KEY;
}

export function isLangSmithEnabled(env: LangSmithEnv = process.env): boolean {
  return Boolean(langSmithApiKey(env));
}

export function langSmithProject(env: LangSmithEnv = process.env): string {
  return env.LANGSMITH_PROJECT ?? env.LANGCHAIN_PROJECT ?? "idiomatic-generation";
}

/** Minimal slice of the LangSmith Client surface we use — keeps the SDK a soft dependency. */
interface LangSmithClientLike {
  createRun(args: Record<string, unknown>): Promise<{ id?: string } | void> | { id?: string } | void;
  createFeedback?(
    runId: string,
    key: string,
    opts: { score: number; comment: string },
  ): Promise<unknown>;
}

/**
 * Resolve the shared LangSmith Client (or null if the SDK isn't installed / not configured),
 * narrowed to the slice the eval upload uses.
 */
export async function getLangSmithClient(
  env: LangSmithEnv = process.env,
): Promise<LangSmithClientLike | null> {
  // Delegate to the shared, flushable client so eval uploads share the one queue that
  // `flushTracing()` drains before the CLI exits (otherwise the auto-batch never sends).
  // Cast via unknown: the real SDK Client is broader than the slice we use here.
  const client = await getSharedLangSmithClient(env as NodeJS.ProcessEnv);
  return (client as unknown as LangSmithClientLike) ?? null;
}

/** Upload one eval run per case with scorer results attached as feedback. Best-effort. */
export async function uploadEvalRun(
  evaluations: readonly CaseEvaluation[],
  env: LangSmithEnv = process.env,
): Promise<{ uploaded: number; project: string } | null> {
  const client = await getLangSmithClient(env);
  if (!client) return null;

  const project = langSmithProject(env);
  let uploaded = 0;

  for (const evaluation of evaluations) {
    try {
      // We mint the run id ourselves rather than relying on createRun's return value (void in
      // this SDK version) so feedback can always be attached. start_time + end_time close the
      // run out — without end_time it would stay "pending"/running forever in the UI.
      const runId = randomUUID();
      const now = Date.now();
      await client.createRun({
        id: runId,
        name: `generation-eval:${evaluation.case.id}`,
        run_type: "chain",
        project_name: project,
        start_time: now,
        end_time: now,
        inputs: { items: evaluation.case.input },
        outputs: {
          pass: evaluation.pass,
          acceptedItemIds: evaluation.acceptedItemIds,
          error: evaluation.error ?? null,
        },
        error: evaluation.error,
      });

      if (typeof client.createFeedback === "function") {
        for (const score of evaluation.scores) {
          await client.createFeedback(runId, score.key, {
            score: score.score,
            comment: score.detail,
          });
        }
      }
      uploaded += 1;
    } catch {
      // Per-case failures shouldn't abort the gate; keep going.
    }
  }

  return { uploaded, project };
}
