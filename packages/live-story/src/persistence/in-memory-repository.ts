import type { Clock, IdGenerator } from "../types";
import type {
  AppendTurnInput,
  LiveSessionRecord,
  LiveStoryRepository,
  OpenSessionInput,
  SessionCorrelation,
  SessionTurnRecord,
} from "./repository";

/**
 * In-memory LiveStoryRepository for tests. Enforces the SAME owner scoping as the
 * Supabase/RLS implementation so privacy (FR-028) is testable without a database, and
 * reproduces the two behaviours the real repo must guarantee:
 *   - ordered turn-index assignment on append (FR-023), and
 *   - in-place upsert of a teacher turn by `elevenTurnRef` on barge-in correction (R5/R6).
 */
export class InMemoryLiveStoryRepository implements LiveStoryRepository {
  private sessions = new Map<string, LiveSessionRecord>(); // keyed by session id

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async openSession(input: OpenSessionInput): Promise<LiveSessionRecord> {
    const now = this.clock.now().toISOString();
    const record: LiveSessionRecord = {
      id: this.ids.next(),
      lessonId: input.lessonId,
      ownerId: input.ownerId,
      status: "active",
      scenario: input.scenario,
      elevenlabsConversationId: null,
      createdAt: now,
      endedAt: null,
      lastActivityAt: now,
      turns: [],
    };
    this.sessions.set(record.id, record);
    return structuredClone(record);
  }

  async getSession(ownerId: string, sessionId: string): Promise<LiveSessionRecord | null> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ownerId !== ownerId) return null;
    return structuredClone(s);
  }

  async appendTurns(
    ownerId: string,
    sessionId: string,
    turns: AppendTurnInput[],
  ): Promise<LiveSessionRecord> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ownerId !== ownerId) throw new Error("appendTurns: session not found/owned");

    for (const t of turns) {
      // Barge-in correction: a teacher turn with a known elevenTurnRef overwrites in place.
      const existing =
        t.elevenTurnRef != null
          ? s.turns.find((x) => x.elevenTurnRef === t.elevenTurnRef)
          : undefined;
      if (existing) {
        existing.text = t.text;
        existing.kind = t.kind;
        existing.role = t.role;
        continue;
      }
      const turn: SessionTurnRecord = {
        role: t.role,
        kind: t.kind,
        text: t.text,
        turnIndex: s.turns.length,
        elevenTurnRef: t.elevenTurnRef,
      };
      s.turns.push(turn);
    }
    s.lastActivityAt = this.clock.now().toISOString();
    return structuredClone(s);
  }

  async updateScenario(ownerId: string, sessionId: string, scenario: string | null): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ownerId !== ownerId) return;
    s.scenario = scenario;
    s.lastActivityAt = this.clock.now().toISOString();
  }

  async endSession(ownerId: string, sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ownerId !== ownerId) return;
    s.status = "ended";
    s.endedAt = this.clock.now().toISOString();
  }

  async setConversationId(
    ownerId: string,
    sessionId: string,
    conversationId: string,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ownerId !== ownerId) return;
    if (!s.elevenlabsConversationId) s.elevenlabsConversationId = conversationId;
    s.lastActivityAt = this.clock.now().toISOString();
  }

  async listTranscript(ownerId: string, lessonId: string): Promise<LiveSessionRecord[]> {
    return structuredClone(
      [...this.sessions.values()]
        .filter((s) => s.ownerId === ownerId && s.lessonId === lessonId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  async findSessionByConversationId(
    conversationId: string,
  ): Promise<SessionCorrelation | null> {
    // Service-role: scan across owners (no owner filter) — the webhook has no owner in hand.
    for (const s of this.sessions.values()) {
      if (s.elevenlabsConversationId === conversationId) {
        return { sessionId: s.id, lessonId: s.lessonId, ownerId: s.ownerId };
      }
    }
    return null;
  }

  async findStaleActiveSessions(
    idleOlderThan: Date,
    limit: number,
  ): Promise<SessionCorrelation[]> {
    const cutoff = idleOlderThan.getTime();
    return [...this.sessions.values()]
      .filter((s) => s.status === "active" && new Date(s.lastActivityAt).getTime() < cutoff)
      .sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt))
      .slice(0, limit)
      .map((s) => ({ sessionId: s.id, lessonId: s.lessonId, ownerId: s.ownerId }));
  }
}
