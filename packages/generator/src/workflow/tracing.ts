import { generateLesson, type GenerateLessonDeps, type GenerateLessonResult } from "../index";
import type { ClassifiedItem } from "../teachability";
import { getSharedLangSmithClient } from "../observability/tracing-runtime";

/**
 * Generation traceability via LangSmith (T052, Constitution III — generation must be
 * observable/traceable).
 *
 * NOTE ON THE PLAN: plan.md called for `@mastra/langsmith`, the exporter for Mastra's
 * telemetry. The generator was implemented as a plain `generateLesson` orchestrator rather
 * than a Mastra runtime, so there is no Mastra trace stream to export. We achieve the same
 * goal directly with the `langsmith` SDK's `traceable` wrapper. LangSmith is a *soft*
 * dependency: with no `LANGSMITH_API_KEY` (or no SDK) this is a transparent pass-through, so
 * the app and CI never depend on it.
 */

function langSmithApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LANGSMITH_API_KEY ?? env.LANGCHAIN_API_KEY;
}

function langSmithProject(env: NodeJS.ProcessEnv = process.env): string {
  return env.LANGSMITH_PROJECT ?? env.LANGCHAIN_PROJECT ?? "idiomatic-generation";
}

export interface TraceMetadata {
  lessonId?: string;
  ownerId?: string;
}

/**
 * Run `generateLesson`, recording a LangSmith trace when configured. Inputs and outputs are
 * summarized (item texts in, segment/coverage counts out) so traces stay readable.
 */
export async function generateLessonTraced(
  acceptedItems: ClassifiedItem[],
  deps: GenerateLessonDeps,
  meta: TraceMetadata = {},
): Promise<GenerateLessonResult> {
  if (!langSmithApiKey()) {
    return generateLesson(acceptedItems, deps);
  }

  try {
    const { traceable } = await import("langsmith/traceable");
    // Trace through the shared client so generation runs sit in the one queue shutdown drains.
    const client = (await getSharedLangSmithClient()) ?? undefined;
    const run = traceable(
      async ({ items }: { items: ClassifiedItem[] }) => generateLesson(items, deps),
      {
        name: "generateLesson",
        run_type: "chain",
        ...(client ? { client: client as never } : {}),
        project_name: langSmithProject(),
        metadata: {
          modelId: deps.config.modelId,
          promptVersion: deps.llm.promptVersion,
          ...meta,
          // Share the lesson's LangSmith Thread (same key the live-story tracer uses) so a
          // lesson's generation and every spoken session appear in one timeline. Omitted when
          // lessonId is unknown (e.g. eval/ad-hoc runs) so those don't form a bogus thread.
          ...(meta.lessonId ? { thread_id: meta.lessonId } : {}),
        },
        processInputs: (inputs: { items: ClassifiedItem[] }) => ({
          itemCount: inputs.items.length,
          items: inputs.items.map((i) => i.normalizedText),
        }),
        processOutputs: (out: GenerateLessonResult) => ({
          segments: out.script.segments.length,
          coverage: out.script.coverage.length,
          modelId: out.metadata.modelId,
          promptVersion: out.metadata.promptVersion,
        }),
      },
    );
    return await run({ items: acceptedItems });
  } catch {
    // Tracing is best-effort; never let it break generation.
    return generateLesson(acceptedItems, deps);
  }
}
