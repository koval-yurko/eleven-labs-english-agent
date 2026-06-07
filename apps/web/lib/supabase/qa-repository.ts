import type { SupabaseClient } from "@supabase/supabase-js";
import type { IdGenerator, Clock } from "../ports";
import type {
  CreateExchangeInput,
  QaExchangeRecord,
  QaRepository,
  QaTurnRecord,
} from "../qa/repository";

/**
 * Supabase-backed QaRepository (0004_qa.sql). Every query filters/stamps `owner_id`, so
 * privacy (FR-018) holds in code; RLS is the second layer. Maps snake_case columns to the
 * camelCase domain records.
 */
export class SupabaseQaRepository implements QaRepository {
  constructor(
    private readonly db: SupabaseClient,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async createExchange(input: CreateExchangeInput): Promise<QaExchangeRecord> {
    const id = this.ids.next();
    const ts = this.clock.now().toISOString();

    const { error: exErr } = await this.db.from("qa_exchanges").insert({
      id,
      lesson_id: input.lessonId,
      owner_id: input.ownerId,
      source_item_id: input.sourceItemId,
      interruption_position_seconds: input.interruptionPositionSeconds,
      exchange_index: input.exchangeIndex,
      elevenlabs_conversation_id: input.elevenlabsConversationId,
      created_at: ts,
    });
    if (exErr) throw new Error(`createExchange: ${exErr.message}`);

    const turnRows = input.turns.map((t) => ({
      id: this.ids.next(),
      exchange_id: id,
      owner_id: input.ownerId,
      role: t.role,
      text: t.text,
      turn_index: t.turnIndex,
      created_at: ts,
    }));
    const { error: turnsErr } = await this.db.from("qa_turns").insert(turnRows);
    if (turnsErr) throw new Error(`createExchange turns: ${turnsErr.message}`);

    return {
      id,
      lessonId: input.lessonId,
      ownerId: input.ownerId,
      sourceItemId: input.sourceItemId,
      interruptionPositionSeconds: input.interruptionPositionSeconds,
      exchangeIndex: input.exchangeIndex,
      elevenlabsConversationId: input.elevenlabsConversationId,
      createdAt: ts,
      turns: input.turns.map((t) => ({ ...t })),
    };
  }

  async listExchanges(ownerId: string, lessonId: string): Promise<QaExchangeRecord[]> {
    const { data: exchanges, error } = await this.db
      .from("qa_exchanges")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("lesson_id", lessonId)
      .order("exchange_index", { ascending: true });
    if (error) throw new Error(`listExchanges: ${error.message}`);

    const rows = (exchanges ?? []) as Row[];
    if (rows.length === 0) return [];

    const { data: turns, error: turnsErr } = await this.db
      .from("qa_turns")
      .select("*")
      .eq("owner_id", ownerId)
      .in(
        "exchange_id",
        rows.map((r) => r.id as string),
      )
      .order("turn_index", { ascending: true });
    if (turnsErr) throw new Error(`listExchanges turns: ${turnsErr.message}`);

    const turnsByExchange = new Map<string, QaTurnRecord[]>();
    for (const t of (turns ?? []) as Row[]) {
      const list = turnsByExchange.get(t.exchange_id as string) ?? [];
      list.push({
        role: t.role as QaTurnRecord["role"],
        text: t.text as string,
        turnIndex: t.turn_index as number,
      });
      turnsByExchange.set(t.exchange_id as string, list);
    }

    return rows.map((r) => ({
      id: r.id as string,
      lessonId: r.lesson_id as string,
      ownerId: r.owner_id as string,
      sourceItemId: (r.source_item_id as string | null) ?? null,
      interruptionPositionSeconds: Number(r.interruption_position_seconds),
      exchangeIndex: r.exchange_index as number,
      elevenlabsConversationId: (r.elevenlabs_conversation_id as string | null) ?? null,
      createdAt: r.created_at as string,
      turns: turnsByExchange.get(r.id as string) ?? [],
    }));
  }
}

type Row = Record<string, unknown>;
