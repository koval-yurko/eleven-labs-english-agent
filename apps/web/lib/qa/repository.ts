import type { QaTurnRole } from "@idiomatic/contracts";

/**
 * Persistence boundary for live-tutor Q&A transcripts (005-live-tutor-qa). Owner-scoped
 * throughout — a learner can only ever read their own exchanges (FR-018), enforced in
 * code here and by RLS (0004_qa.sql) as defense in depth. Append-only: exchanges/turns
 * are created and listed, never updated or deleted (they cascade with the lesson).
 */

export interface QaTurnRecord {
  role: QaTurnRole;
  text: string;
  turnIndex: number;
}

export interface QaExchangeRecord {
  id: string;
  lessonId: string;
  ownerId: string;
  sourceItemId: string | null;
  interruptionPositionSeconds: number;
  exchangeIndex: number;
  elevenlabsConversationId: string | null;
  createdAt: string;
  turns: QaTurnRecord[];
}

export interface CreateExchangeInput {
  lessonId: string;
  ownerId: string;
  sourceItemId: string | null;
  interruptionPositionSeconds: number;
  exchangeIndex: number;
  elevenlabsConversationId: string | null;
  turns: QaTurnRecord[];
}

export interface QaRepository {
  /** Persist one exchange + its ordered turns (all stamped with ownerId). */
  createExchange(input: CreateExchangeInput): Promise<QaExchangeRecord>;

  /** Owner-scoped list for a lesson, ordered by exchangeIndex. */
  listExchanges(ownerId: string, lessonId: string): Promise<QaExchangeRecord[]>;
}
