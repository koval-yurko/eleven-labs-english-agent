import type { IdGenerator, Clock } from "../ports";
import type {
  CreatePendingLessonInput,
  LessonRepository,
  ReadyLessonUpdate,
} from "./repository";
import type { LessonRecord, SourceItemRecord } from "./types";

/**
 * In-memory LessonRepository for tests. Enforces the SAME owner scoping as the
 * Supabase/RLS implementation so privacy (FR-019/SC-005) is testable without a DB.
 */
export class InMemoryLessonRepository implements LessonRepository {
  private lessons = new Map<string, LessonRecord>();
  private items = new Map<string, SourceItemRecord[]>();

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async createPendingLesson(input: CreatePendingLessonInput): Promise<LessonRecord> {
    const id = this.ids.next();
    const ts = this.clock.now().toISOString();
    const lesson: LessonRecord = {
      id,
      ownerId: input.ownerId,
      status: "pending",
      acceptedItemCount: input.acceptedItemCount,
      targetDurationSeconds: input.targetDurationSeconds,
      script: null,
      errorReason: null,
      modelId: null,
      promptVersion: null,
      generationInput: input.generationInput,
      createdAt: ts,
      updatedAt: ts,
    };
    this.lessons.set(id, lesson);
    this.items.set(
      id,
      input.sourceItems.map((si) => ({
        ...si,
        id: this.ids.next(),
        lessonId: id,
        ownerId: input.ownerId,
      })),
    );
    return structuredClone(lesson);
  }

  async getLesson(ownerId: string, id: string): Promise<LessonRecord | null> {
    const lesson = this.lessons.get(id);
    if (!lesson || lesson.ownerId !== ownerId) return null;
    return structuredClone(lesson);
  }

  async getSourceItems(ownerId: string, lessonId: string): Promise<SourceItemRecord[]> {
    const lesson = this.lessons.get(lessonId);
    if (!lesson || lesson.ownerId !== ownerId) return [];
    return structuredClone(this.items.get(lessonId) ?? []).sort(
      (a, b) => a.orderIndex - b.orderIndex,
    );
  }

  async listLessons(ownerId: string): Promise<LessonRecord[]> {
    return structuredClone(
      [...this.lessons.values()]
        .filter((l) => l.ownerId === ownerId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  async setStatus(id: string, status: LessonRecord["status"]): Promise<void> {
    const lesson = this.lessons.get(id);
    if (!lesson) return;
    lesson.status = status;
    lesson.updatedAt = this.clock.now().toISOString();
  }

  async markReady(id: string, update: ReadyLessonUpdate): Promise<void> {
    const lesson = this.lessons.get(id);
    if (!lesson) return;
    lesson.status = "ready";
    lesson.script = update.script;
    lesson.modelId = update.modelId;
    lesson.promptVersion = update.promptVersion;
    lesson.errorReason = null;
    lesson.updatedAt = this.clock.now().toISOString();

    const covered = new Set(update.coveredOrderIndexes);
    for (const si of this.items.get(id) ?? []) {
      if (covered.has(si.orderIndex)) si.covered = true;
    }
  }

  async markFailed(id: string, errorReason: string): Promise<void> {
    const lesson = this.lessons.get(id);
    if (!lesson) return;
    lesson.status = "failed";
    lesson.errorReason = errorReason;
    lesson.updatedAt = this.clock.now().toISOString();
  }
}
