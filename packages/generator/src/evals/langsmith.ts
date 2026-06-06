import type { CaseEvaluation } from "./harness";

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

type ClientCtor = new (opts: { apiKey: string }) => LangSmithClientLike;
interface LangSmithModule {
  Client?: ClientCtor;
  default?: { Client?: ClientCtor };
}

/**
 * Lazily resolve a LangSmith Client, or null if the SDK isn't installed / not configured.
 * Dynamic import keeps `langsmith` out of the runtime path for the app and CI.
 */
export async function getLangSmithClient(
  env: LangSmithEnv = process.env,
): Promise<LangSmithClientLike | null> {
  const apiKey = langSmithApiKey(env);
  if (!apiKey) return null;
  try {
    // Cast via unknown: the real SDK types are broader than the slice we use.
    const mod = (await import("langsmith")) as unknown as LangSmithModule;
    const Client = mod.Client ?? mod.default?.Client;
    if (!Client) return null;
    return new Client({ apiKey });
  } catch {
    // SDK not installed — degrade silently to no-op.
    return null;
  }
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
      const run = await client.createRun({
        name: `generation-eval:${evaluation.case.id}`,
        run_type: "chain",
        project_name: project,
        inputs: { items: evaluation.case.input },
        outputs: {
          pass: evaluation.pass,
          acceptedItemIds: evaluation.acceptedItemIds,
          error: evaluation.error ?? null,
        },
        error: evaluation.error,
      });

      // createRun may return void in some SDK versions; only add feedback when we have an id.
      const runId = run && typeof run === "object" ? run.id : undefined;
      if (runId && typeof client.createFeedback === "function") {
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
