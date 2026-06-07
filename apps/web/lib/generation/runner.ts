import {
  CoverageError,
  generateLessonTraced,
  noopLogger,
  type GenerateLessonDeps,
  type Logger,
} from "@idiomatic/generator";
import type { ClassifiedItem } from "@idiomatic/generator";
import type { LessonRepository } from "../lessons/repository";
import type { AudioStorage } from "./storage";

/**
 * Generation bridge (T026/T027). Advances a lesson `pending → generating → ready|failed`,
 * persisting the script, stitched audio, measured duration, and reproducibility metadata.
 * Generation lives in the DB (research R6), so it survives the learner leaving the session.
 *
 * Observability (003-internal-logging): each run mints a child logger bound to
 * `{ lessonId, ownerId }` and injects it into generation, so the whole trail — lifecycle
 * transitions, pipeline stages, and failures — is retrievable by lesson id alone.
 */
export class GenerationRunner {
  constructor(
    private readonly repo: LessonRepository,
    private readonly storage: AudioStorage,
    private readonly deps: GenerateLessonDeps,
    private readonly logger: Logger = noopLogger,
  ) {}

  async run(lessonId: string, ownerId: string, acceptedItems: ClassifiedItem[]): Promise<void> {
    const log = this.logger.child({ lessonId, ownerId });

    // Capture the prior status so a retry logs `failed → generating`, not `pending → …`.
    const prior = await this.repo.getLesson(ownerId, lessonId);
    const from = prior?.status ?? "pending";

    await this.repo.setStatus(lessonId, "generating");
    log.info("lesson.status", `lesson ${from} → generating`, { from, to: "generating" });

    try {
      const result = await generateLessonTraced(
        acceptedItems,
        { ...this.deps, logger: log },
        { lessonId, ownerId },
      );
      const { storagePath } = await this.storage.upload(
        ownerId,
        lessonId,
        result.audio.bytes,
        result.audio.mimeType,
      );

      // generateLesson guarantees coverage, so every accepted item is covered.
      const coveredOrderIndexes = acceptedItems.map((i) => i.orderIndex);

      await this.repo.markReady(lessonId, {
        script: result.script,
        audioDurationSeconds: result.audio.durationSeconds,
        modelId: result.metadata.modelId,
        promptVersion: result.metadata.promptVersion,
        coveredOrderIndexes,
        audio: {
          storagePath,
          mimeType: result.audio.mimeType,
          durationSeconds: result.audio.durationSeconds,
        },
      });
      log.info("lesson.status", "lesson generating → ready", {
        from: "generating",
        to: "ready",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Lesson generation failed.";
      const stage = err instanceof CoverageError ? "coverage" : "generation";
      log.error("generate.error", `generation failed at ${stage}`, { stage, reason: message });
      await this.repo.markFailed(lessonId, message);
      log.error("lesson.status", "lesson generating → failed", {
        from: "generating",
        to: "failed",
        reason: message,
      });
    }
  }
}
