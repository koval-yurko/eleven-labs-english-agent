import type {
  LessonStatusDTO,
  LessonSummary,
  SkippedEntry,
  SourceItem,
} from "@idiomatic/contracts";
import { decideSubmission, noopLogger } from "@idiomatic/generator";
import type { ClassifiedItem, Logger } from "@idiomatic/generator";
import type { GenerationRunner } from "../generation/runner";
import type { LessonRepository } from "./repository";
import type { TaskScheduler } from "./scheduler";
import type { LessonRecord, SourceItemRecord } from "./types";

export interface LessonServiceConfig {
  maxTeachableItems: number;
  targetMinSeconds: number;
  targetMaxSeconds: number;
}

/** Typed outcomes the API route maps to HTTP responses (contracts/http-api.md). */
export type CreateLessonOutcome =
  | { ok: true; lesson: LessonStatusDTO }
  | {
      ok: false;
      status: 400 | 413;
      code: string;
      message: string;
      skipped?: SkippedEntry[];
      limit?: number;
      received?: number;
    };

export type RetryOutcome =
  | { ok: true; lesson: LessonStatusDTO }
  | { ok: false; status: 404 | 409; code: string; message: string };

export interface LessonDetailDTO extends LessonStatusDTO {
  items: Pick<SourceItem, "normalizedText" | "itemType" | "covered">[];
}

/**
 * Central lesson business logic. Owner-scoped throughout (FR-019). Coordinates input
 * guardrails (FR-004..007), pending-lesson creation owned by the caller (T026/T028),
 * background generation (R6), the library list (FR-020), and retry (FR-016). A lesson is
 * ready once it has a valid script — there is no pre-rendered audio (007-live-only).
 */
export class LessonService {
  constructor(
    private readonly repo: LessonRepository,
    private readonly runner: GenerationRunner,
    private readonly scheduler: TaskScheduler,
    private readonly config: LessonServiceConfig,
    private readonly logger: Logger = noopLogger,
  ) {}

  async createLesson(ownerId: string, input: string | string[]): Promise<CreateLessonOutcome> {
    const decision = decideSubmission(input, this.config.maxTeachableItems);

    if (!decision.ok) {
      if (decision.code === "too_many_items") {
        return {
          ok: false,
          status: 413,
          code: decision.code,
          message: decision.message,
          limit: decision.limit,
          received: decision.received,
        };
      }
      return {
        ok: false,
        status: 400,
        code: decision.code,
        message: decision.message,
        skipped: decision.code === "no_teachable_items" ? decision.skipped : undefined,
      };
    }

    const { result } = decision;
    const targetDurationSeconds = Math.round(
      (this.config.targetMinSeconds + this.config.targetMaxSeconds) / 2,
    );

    const lesson = await this.repo.createPendingLesson({
      ownerId,
      generationInput: { items: result.items.map((i) => i.rawText) },
      requestedItemCount: result.items.length,
      acceptedItemCount: result.accepted.length,
      skippedItemCount: result.skipped.length,
      targetDurationSeconds,
      sourceItems: result.items.map((i) => ({
        rawText: i.rawText,
        normalizedText: i.normalizedText,
        itemType: i.itemType,
        teachable: i.teachable,
        skipReason: i.skipReason,
        orderIndex: i.orderIndex,
        covered: false,
      })),
    });

    // Now that a lesson id exists, emit the correlated teachability trail (US1/US3).
    const log = this.logger.child({ lessonId: lesson.id, ownerId });
    log.info("teachability.summary", "classified submission", {
      requested: result.items.length,
      accepted: result.accepted.length,
      skipped: result.skipped.length,
    });
    for (const item of result.items) {
      log.info("teachability.item", `item ${item.id} ${item.teachable ? "accepted" : "skipped"}`, {
        id: item.id,
        itemType: item.itemType,
        decision: item.teachable ? "accepted" : "skipped",
        ...(item.skipReason ? { skipReason: item.skipReason } : {}),
        // Raw learner text is privacy-sensitive — debug only (FR-017).
        ...(log.enabled("debug") ? { text: item.rawText } : {}),
      });
    }

    // Kick off generation in the background; POST returns 202 immediately (R6).
    const acceptedItems: ClassifiedItem[] = result.accepted;
    this.scheduler.schedule(() => this.runner.run(lesson.id, ownerId, acceptedItems));

    return { ok: true, lesson: toStatusDTO(lesson, decision.skipped) };
  }

  async getLesson(ownerId: string, id: string): Promise<LessonDetailDTO | null> {
    const lesson = await this.repo.getLesson(ownerId, id);
    if (!lesson) return null;
    const items = await this.repo.getSourceItems(ownerId, id);

    return {
      ...toStatusDTO(lesson, skippedFromItems(items)),
      items: items
        .filter((i) => i.teachable)
        .map((i) => ({
          normalizedText: i.normalizedText,
          itemType: i.itemType,
          covered: i.covered,
        })),
    };
  }

  async listLessons(ownerId: string): Promise<LessonSummary[]> {
    const lessons = await this.repo.listLessons(ownerId);
    const summaries: LessonSummary[] = [];
    for (const lesson of lessons) {
      const items = await this.repo.getSourceItems(ownerId, lesson.id);
      summaries.push({
        id: lesson.id,
        status: lesson.status,
        itemPreview: items.filter((i) => i.teachable).map((i) => i.normalizedText),
        acceptedItemCount: lesson.acceptedItemCount,
        createdAt: lesson.createdAt,
      });
    }
    return summaries;
  }

  async retry(ownerId: string, id: string): Promise<RetryOutcome> {
    const lesson = await this.repo.getLesson(ownerId, id);
    if (!lesson) {
      return { ok: false, status: 404, code: "not_found", message: "Lesson not found." };
    }
    if (lesson.status !== "failed") {
      return {
        ok: false,
        status: 409,
        code: "not_failed",
        message: "Only a failed lesson can be retried.",
      };
    }

    const items = await this.repo.getSourceItems(ownerId, id);
    const acceptedItems: ClassifiedItem[] = items
      .filter((i) => i.teachable)
      .map((i) => ({
        id: `item-${i.orderIndex}`,
        rawText: i.rawText,
        normalizedText: i.normalizedText,
        itemType: i.itemType,
        teachable: true,
        skipReason: null,
        orderIndex: i.orderIndex,
      }));

    this.scheduler.schedule(() => this.runner.run(lesson.id, ownerId, acceptedItems));
    return { ok: true, lesson: toStatusDTO({ ...lesson, status: "generating" }, []) };
  }
}

function toStatusDTO(lesson: LessonRecord, skipped: SkippedEntry[]): LessonStatusDTO {
  return {
    id: lesson.id,
    status: lesson.status,
    requestedItemCount: lesson.requestedItemCount,
    acceptedItemCount: lesson.acceptedItemCount,
    skipped,
    errorReason: lesson.errorReason,
    createdAt: lesson.createdAt,
  };
}

function skippedFromItems(items: SourceItemRecord[]): SkippedEntry[] {
  return items
    .filter((i) => !i.teachable && i.skipReason !== null)
    .map((i) => ({ rawText: i.rawText, reason: i.skipReason! }));
}
