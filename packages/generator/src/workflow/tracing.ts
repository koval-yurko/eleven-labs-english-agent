import { generateLesson, type GenerateLessonDeps, type GenerateLessonResult } from "../index";
import type { ClassifiedItem } from "../teachability";

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
 * summarized (item texts in, segment/coverage/duration counts out) so traces stay readable
 * and never carry raw audio bytes.
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
    const run = traceable(
      async ({ items }: { items: ClassifiedItem[] }) => generateLesson(items, deps),
      {
        name: "generateLesson",
        run_type: "chain",
        project_name: langSmithProject(),
        metadata: {
          modelId: deps.config.modelId,
          ttsModelId: deps.config.ttsModelId,
          promptVersion: deps.llm.promptVersion,
          ...meta,
        },
        processInputs: (inputs: { items: ClassifiedItem[] }) => ({
          itemCount: inputs.items.length,
          items: inputs.items.map((i) => i.normalizedText),
        }),
        processOutputs: (out: GenerateLessonResult) => ({
          segments: out.script.segments.length,
          coverage: out.script.coverage.length,
          durationSeconds: out.audio.durationSeconds,
          audioBytes: out.audio.bytes.length,
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
