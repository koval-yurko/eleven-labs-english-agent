import type { SupabaseClient } from "@supabase/supabase-js";
import type { Clock, IdGenerator } from "../ports";
import type {
  AppendTurnInput,
  LiveSessionRecord,
  LiveStoryRepository,
  OpenSessionInput,
  SessionCorrelation,
  SessionTurnRecord,
} from "@idiomatic/live-story";

/**
 * Supabase-backed LiveStoryRepository (0005_live_story.sql). Every query filters/stamps
 * `owner_id`, so privacy (FR-028) holds in code; RLS is the second layer (same Auth0-subject
 * scoping as 0004_qa.sql). Maps snake_case columns to the camelCase domain records.
 *
 * Append assigns each new turn the next `turnIndex` for the session; a teacher turn whose
 * `elevenTurnRef` matches an existing row is updated in place (the single permitted
 * mutation — barge-in correction, R5/R6).
 */
export class SupabaseLiveStoryRepository implements LiveStoryRepository {
  constructor(
    private readonly db: SupabaseClient,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async openSession(input: OpenSessionInput): Promise<LiveSessionRecord> {
    const id = this.ids.next();
    const ts = this.clock.now().toISOString();
    const { error } = await this.db.from("live_sessions").insert({
      id,
      lesson_id: input.lessonId,
      owner_id: input.ownerId,
      status: "active",
      scenario: input.scenario,
      elevenlabs_conversation_id: null,
      created_at: ts,
      ended_at: null,
      last_activity_at: ts,
    });
    if (error) throw new Error(`openSession: ${error.message}`);
    return {
      id,
      lessonId: input.lessonId,
      ownerId: input.ownerId,
      status: "active",
      scenario: input.scenario,
      elevenlabsConversationId: null,
      createdAt: ts,
      endedAt: null,
      lastActivityAt: ts,
      turns: [],
    };
  }

  async getSession(ownerId: string, sessionId: string): Promise<LiveSessionRecord | null> {
    const { data, error } = await this.db
      .from("live_sessions")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("id", sessionId)
      .maybeSingle();
    if (error) throw new Error(`getSession: ${error.message}`);
    if (!data) return null;
    const turns = await this.loadTurns(ownerId, sessionId);
    return toSessionRecord(data as Row, turns);
  }

  async appendTurns(
    ownerId: string,
    sessionId: string,
    turns: AppendTurnInput[],
  ): Promise<LiveSessionRecord> {
    // Load current turns once to (a) detect barge-in corrections by elevenTurnRef and
    // (b) assign the next contiguous turn index for genuinely new turns (FR-023).
    const current = await this.loadTurns(ownerId, sessionId);
    const byRef = new Map<string, SessionTurnRecord>();
    for (const t of current) if (t.elevenTurnRef) byRef.set(t.elevenTurnRef, t);

    let nextIndex = current.length;
    const ts = this.clock.now().toISOString();

    for (const t of turns) {
      const existing = t.elevenTurnRef != null ? byRef.get(t.elevenTurnRef) : undefined;
      if (existing) {
        const { error } = await this.db
          .from("session_turns")
          .update({ text: t.text, role: t.role, kind: t.kind })
          .eq("owner_id", ownerId)
          .eq("session_id", sessionId)
          .eq("turn_index", existing.turnIndex);
        if (error) throw new Error(`appendTurns (correction): ${error.message}`);
        existing.text = t.text;
        continue;
      }
      const { error } = await this.db.from("session_turns").insert({
        id: this.ids.next(),
        session_id: sessionId,
        owner_id: ownerId,
        role: t.role,
        kind: t.kind,
        text: t.text,
        turn_index: nextIndex,
        eleven_turn_ref: t.elevenTurnRef,
        created_at: ts,
      });
      if (error) throw new Error(`appendTurns: ${error.message}`);
      nextIndex += 1;
    }

    // Bump the activity clock so the abandonment sweep (008) only closes truly idle sessions.
    const { error: touchErr } = await this.db
      .from("live_sessions")
      .update({ last_activity_at: ts })
      .eq("owner_id", ownerId)
      .eq("id", sessionId);
    if (touchErr) throw new Error(`appendTurns (touch): ${touchErr.message}`);

    const session = await this.getSession(ownerId, sessionId);
    if (!session) throw new Error("appendTurns: session not found/owned");
    return session;
  }

  async updateScenario(ownerId: string, sessionId: string, scenario: string | null): Promise<void> {
    const { error } = await this.db
      .from("live_sessions")
      .update({ scenario, last_activity_at: this.clock.now().toISOString() })
      .eq("owner_id", ownerId)
      .eq("id", sessionId);
    if (error) throw new Error(`updateScenario: ${error.message}`);
  }

  async endSession(ownerId: string, sessionId: string): Promise<void> {
    const { error } = await this.db
      .from("live_sessions")
      .update({ status: "ended", ended_at: this.clock.now().toISOString() })
      .eq("owner_id", ownerId)
      .eq("id", sessionId);
    if (error) throw new Error(`endSession: ${error.message}`);
  }

  async setConversationId(
    ownerId: string,
    sessionId: string,
    conversationId: string,
  ): Promise<void> {
    // Only set when not yet present (reproducibility; don't clobber a prior id).
    const { error } = await this.db
      .from("live_sessions")
      .update({
        elevenlabs_conversation_id: conversationId,
        last_activity_at: this.clock.now().toISOString(),
      })
      .eq("owner_id", ownerId)
      .eq("id", sessionId)
      .is("elevenlabs_conversation_id", null);
    if (error) throw new Error(`setConversationId: ${error.message}`);
  }

  async listTranscript(ownerId: string, lessonId: string): Promise<LiveSessionRecord[]> {
    const { data: sessions, error } = await this.db
      .from("live_sessions")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("lesson_id", lessonId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`listTranscript: ${error.message}`);

    const rows = (sessions ?? []) as Row[];
    if (rows.length === 0) return [];

    const { data: turns, error: turnsErr } = await this.db
      .from("session_turns")
      .select("*")
      .eq("owner_id", ownerId)
      .in(
        "session_id",
        rows.map((r) => r.id as string),
      )
      .order("turn_index", { ascending: true });
    if (turnsErr) throw new Error(`listTranscript turns: ${turnsErr.message}`);

    const turnsBySession = new Map<string, SessionTurnRecord[]>();
    for (const t of (turns ?? []) as Row[]) {
      const list = turnsBySession.get(t.session_id as string) ?? [];
      list.push(toTurnRecord(t));
      turnsBySession.set(t.session_id as string, list);
    }

    return rows.map((r) => toSessionRecord(r, turnsBySession.get(r.id as string) ?? []));
  }

  async findSessionByConversationId(
    conversationId: string,
  ): Promise<SessionCorrelation | null> {
    // SERVICE-ROLE (008-langsmith-tracing, R3): no owner filter — the webhook caller has no
    // owner in hand and looks it up from the conversation id. Uses live_sessions_conversation_idx.
    const { data, error } = await this.db
      .from("live_sessions")
      .select("id, lesson_id, owner_id")
      .eq("elevenlabs_conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`findSessionByConversationId: ${error.message}`);
    if (!data) return null;
    const r = data as Row;
    return {
      sessionId: r.id as string,
      lessonId: r.lesson_id as string,
      ownerId: r.owner_id as string,
    };
  }

  async findStaleActiveSessions(
    idleOlderThan: Date,
    limit: number,
  ): Promise<SessionCorrelation[]> {
    // SERVICE-ROLE (008-langsmith-tracing, R5): active sessions idle past the cutoff, oldest
    // first, bounded. Uses live_sessions_stale_idx (status, last_activity_at).
    const { data, error } = await this.db
      .from("live_sessions")
      .select("id, lesson_id, owner_id")
      .eq("status", "active")
      .lt("last_activity_at", idleOlderThan.toISOString())
      .order("last_activity_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`findStaleActiveSessions: ${error.message}`);
    return ((data ?? []) as Row[]).map((r) => ({
      sessionId: r.id as string,
      lessonId: r.lesson_id as string,
      ownerId: r.owner_id as string,
    }));
  }

  private async loadTurns(ownerId: string, sessionId: string): Promise<SessionTurnRecord[]> {
    const { data, error } = await this.db
      .from("session_turns")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("session_id", sessionId)
      .order("turn_index", { ascending: true });
    if (error) throw new Error(`loadTurns: ${error.message}`);
    return ((data ?? []) as Row[]).map(toTurnRecord);
  }
}

type Row = Record<string, unknown>;

function toTurnRecord(t: Row): SessionTurnRecord {
  return {
    role: t.role as SessionTurnRecord["role"],
    kind: t.kind as SessionTurnRecord["kind"],
    text: t.text as string,
    turnIndex: t.turn_index as number,
    elevenTurnRef: (t.eleven_turn_ref as string | null) ?? null,
  };
}

function toSessionRecord(r: Row, turns: SessionTurnRecord[]): LiveSessionRecord {
  return {
    id: r.id as string,
    lessonId: r.lesson_id as string,
    ownerId: r.owner_id as string,
    status: r.status as LiveSessionRecord["status"],
    scenario: (r.scenario as string | null) ?? null,
    elevenlabsConversationId: (r.elevenlabs_conversation_id as string | null) ?? null,
    createdAt: r.created_at as string,
    endedAt: (r.ended_at as string | null) ?? null,
    // Backfill to createdAt for any pre-0007 row read before the column default applied.
    lastActivityAt: (r.last_activity_at as string | null) ?? (r.created_at as string),
    turns,
  };
}
