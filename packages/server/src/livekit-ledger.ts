import type { TurnRecord } from "@tutor/shared/tutor/livekit-wire";

import { getServiceSupabase } from "./supabase/server";

/**
 * Storage for the LiveKit worker's per-turn ledger (`supabase/migrations/0020_livekit_turn_ledger.sql`).
 *
 * One row per turn, upserted on `(conversation_id, seq)`. The worker posts batches while the lesson
 * runs, so this has to be idempotent and order-independent: a retried batch overwrites itself, and
 * two batches in flight cannot erase each other the way a read-modify-write of one jsonb document
 * would. See docs/2026-09-11-livekit-claude-diy-provider.md §5.2.
 *
 * The service client, with `owner_id` stamped explicitly from the verified grant — the same posture
 * every other write in this repo takes, with RLS as defense in depth rather than as the check.
 */
export async function storeTurnLedger(input: {
  conversationId: string;
  ownerId: string;
  turns: TurnRecord[];
}): Promise<void> {
  if (input.turns.length === 0) return;

  const rows = input.turns.map((record) => ({
    conversation_id: input.conversationId,
    seq: record.seq,
    owner_id: input.ownerId,
    record,
  }));

  const { error } = await getServiceSupabase()
    .from("livekit_turn_ledger")
    .upsert(rows, { onConflict: "conversation_id,seq" });
  if (error) throw new Error(`storeTurnLedger: ${error.message}`);
}

/** One lesson's ledger, in turn order. The read Phase 4's cost and latency work makes. */
export async function listTurnLedger(
  ownerId: string,
  conversationId: string,
): Promise<TurnRecord[]> {
  const { data, error } = await getServiceSupabase()
    .from("livekit_turn_ledger")
    .select("record")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .order("seq", { ascending: true });
  if (error) throw new Error(`listTurnLedger: ${error.message}`);
  return (data ?? []).map((row) => row.record as TurnRecord);
}
