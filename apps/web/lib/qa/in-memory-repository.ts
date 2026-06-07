import type { Clock, IdGenerator } from "../ports";
import type {
  CreateExchangeInput,
  QaExchangeRecord,
  QaRepository,
} from "./repository";

/**
 * In-memory QaRepository for tests. Enforces the SAME owner scoping as the Supabase/RLS
 * implementation so privacy (FR-018) is testable without a database.
 */
export class InMemoryQaRepository implements QaRepository {
  private exchanges = new Map<string, QaExchangeRecord[]>(); // keyed by lessonId

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async createExchange(input: CreateExchangeInput): Promise<QaExchangeRecord> {
    const record: QaExchangeRecord = {
      id: this.ids.next(),
      lessonId: input.lessonId,
      ownerId: input.ownerId,
      sourceItemId: input.sourceItemId,
      interruptionPositionSeconds: input.interruptionPositionSeconds,
      exchangeIndex: input.exchangeIndex,
      elevenlabsConversationId: input.elevenlabsConversationId,
      createdAt: this.clock.now().toISOString(),
      turns: input.turns.map((t) => ({ ...t })),
    };
    const list = this.exchanges.get(input.lessonId) ?? [];
    list.push(record);
    this.exchanges.set(input.lessonId, list);
    return structuredClone(record);
  }

  async listExchanges(ownerId: string, lessonId: string): Promise<QaExchangeRecord[]> {
    const list = this.exchanges.get(lessonId) ?? [];
    return structuredClone(
      list.filter((e) => e.ownerId === ownerId).sort((a, b) => a.exchangeIndex - b.exchangeIndex),
    );
  }
}
