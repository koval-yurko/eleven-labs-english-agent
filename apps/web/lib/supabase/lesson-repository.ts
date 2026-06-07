import type { SupabaseClient } from "@supabase/supabase-js";
import type { IdGenerator, Clock } from "../ports";
import type {
  CreatePendingLessonInput,
  LessonRepository,
  ReadyLessonUpdate,
} from "../lessons/repository";
import type { LessonRecord, SourceItemRecord } from "../lessons/types";

/**
 * Supabase-backed LessonRepository (T038). Every query filters/stamps `owner_id`, so
 * privacy (FR-019) holds in code; RLS (0003_rls.sql) is the second layer. Maps between
 * snake_case columns (data-model.md) and the camelCase domain records.
 */
export class SupabaseLessonRepository implements LessonRepository {
  constructor(
    private readonly db: SupabaseClient,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async createPendingLesson(input: CreatePendingLessonInput): Promise<LessonRecord> {
    const id = this.ids.next();
    const ts = this.clock.now().toISOString();

    const { error: lessonErr } = await this.db.from("lessons").insert({
      id,
      owner_id: input.ownerId,
      status: "pending",
      requested_item_count: input.requestedItemCount,
      accepted_item_count: input.acceptedItemCount,
      skipped_item_count: input.skippedItemCount,
      target_duration_seconds: input.targetDurationSeconds,
      generation_input: input.generationInput,
      created_at: ts,
      updated_at: ts,
    });
    if (lessonErr) throw new Error(`createPendingLesson: ${lessonErr.message}`);

    const itemRows = input.sourceItems.map((si) => ({
      id: this.ids.next(),
      lesson_id: id,
      owner_id: input.ownerId,
      raw_text: si.rawText,
      normalized_text: si.normalizedText,
      item_type: si.itemType,
      teachable: si.teachable,
      skip_reason: si.skipReason,
      order_index: si.orderIndex,
      covered: si.covered,
    }));
    if (itemRows.length > 0) {
      const { error: itemsErr } = await this.db.from("source_items").insert(itemRows);
      if (itemsErr) throw new Error(`createPendingLesson items: ${itemsErr.message}`);
    }

    return {
      id,
      ownerId: input.ownerId,
      status: "pending",
      requestedItemCount: input.requestedItemCount,
      acceptedItemCount: input.acceptedItemCount,
      skippedItemCount: input.skippedItemCount,
      targetDurationSeconds: input.targetDurationSeconds,
      script: null,
      errorReason: null,
      modelId: null,
      promptVersion: null,
      generationInput: input.generationInput,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  async getLesson(ownerId: string, id: string): Promise<LessonRecord | null> {
    const { data, error } = await this.db
      .from("lessons")
      .select("*")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (error) throw new Error(`getLesson: ${error.message}`);
    return data ? mapLesson(data) : null;
  }

  async getSourceItems(ownerId: string, lessonId: string): Promise<SourceItemRecord[]> {
    const { data, error } = await this.db
      .from("source_items")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("lesson_id", lessonId)
      .order("order_index", { ascending: true });
    if (error) throw new Error(`getSourceItems: ${error.message}`);
    return (data ?? []).map(mapSourceItem);
  }

  async listLessons(ownerId: string): Promise<LessonRecord[]> {
    const { data, error } = await this.db
      .from("lessons")
      .select("*")
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`listLessons: ${error.message}`);
    return (data ?? []).map(mapLesson);
  }

  async setStatus(id: string, status: LessonRecord["status"]): Promise<void> {
    const { error } = await this.db
      .from("lessons")
      .update({ status, updated_at: this.clock.now().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`setStatus: ${error.message}`);
  }

  async markReady(id: string, update: ReadyLessonUpdate): Promise<void> {
    const ts = this.clock.now().toISOString();
    const { error: lessonErr } = await this.db
      .from("lessons")
      .update({
        status: "ready",
        script: update.script,
        model_id: update.modelId,
        prompt_version: update.promptVersion,
        error_reason: null,
        updated_at: ts,
      })
      .eq("id", id);
    if (lessonErr) throw new Error(`markReady: ${lessonErr.message}`);

    if (update.coveredOrderIndexes.length > 0) {
      const { error: coverErr } = await this.db
        .from("source_items")
        .update({ covered: true })
        .eq("lesson_id", id)
        .in("order_index", update.coveredOrderIndexes);
      if (coverErr) throw new Error(`markReady covered: ${coverErr.message}`);
    }
  }

  async markFailed(id: string, errorReason: string): Promise<void> {
    const { error } = await this.db
      .from("lessons")
      .update({ status: "failed", error_reason: errorReason, updated_at: this.clock.now().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`markFailed: ${error.message}`);
  }
}

type Row = Record<string, unknown>;

function mapLesson(r: Row): LessonRecord {
  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    status: r.status as LessonRecord["status"],
    requestedItemCount: r.requested_item_count as number,
    acceptedItemCount: r.accepted_item_count as number,
    skippedItemCount: r.skipped_item_count as number,
    targetDurationSeconds: r.target_duration_seconds as number,
    script: (r.script as LessonRecord["script"]) ?? null,
    errorReason: (r.error_reason as string | null) ?? null,
    modelId: (r.model_id as string | null) ?? null,
    promptVersion: (r.prompt_version as string | null) ?? null,
    generationInput: r.generation_input as { items: string[] },
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapSourceItem(r: Row): SourceItemRecord {
  return {
    id: r.id as string,
    lessonId: r.lesson_id as string,
    ownerId: r.owner_id as string,
    rawText: r.raw_text as string,
    normalizedText: r.normalized_text as string,
    itemType: r.item_type as SourceItemRecord["itemType"],
    teachable: r.teachable as boolean,
    skipReason: (r.skip_reason as SourceItemRecord["skipReason"]) ?? null,
    orderIndex: r.order_index as number,
    covered: r.covered as boolean,
  };
}
