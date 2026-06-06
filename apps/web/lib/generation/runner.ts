import { generateLesson, type GenerateLessonDeps } from "@idiomatic/generator";
import type { ClassifiedItem } from "@idiomatic/generator";
import type { LessonRepository } from "../lessons/repository";
import type { AudioStorage } from "./storage";

/**
 * Generation bridge (T026/T027). Advances a lesson `pending → generating → ready|failed`,
 * persisting the script, stitched audio, measured duration, and reproducibility metadata.
 * Generation lives in the DB (research R6), so it survives the learner leaving the session.
 */
export class GenerationRunner {
  constructor(
    private readonly repo: LessonRepository,
    private readonly storage: AudioStorage,
    private readonly deps: GenerateLessonDeps,
  ) {}

  async run(lessonId: string, ownerId: string, acceptedItems: ClassifiedItem[]): Promise<void> {
    await this.repo.setStatus(lessonId, "generating");
    try {
      const result = await generateLesson(acceptedItems, this.deps);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Lesson generation failed.";
      await this.repo.markFailed(lessonId, message);
    }
  }
}
