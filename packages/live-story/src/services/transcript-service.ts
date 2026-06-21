import type { AppendTurnRequest, LiveSession, TranscriptDTO } from "@idiomatic/contracts";
import { isRoleKindConsistent } from "@idiomatic/contracts";
import { noopLogger, type Logger } from "@idiomatic/generator";
import type { LessonReader } from "../types";
import type { LiveSessionRecord, LiveStoryRepository } from "../persistence/repository";

/**
 * Persists and lists the durable live-story transcript (US5). Owner-scoped throughout
 * (FR-028). Append is incremental and OFF the speech path (the client posts as turns
 * finalize, FR-027): each turn is assigned the next `turnIndex` and stamped with the owner
 * (in the repo); a teacher turn carrying a known `elevenTurnRef` is upserted in place — the
 * barge-in correction (R5/R6). The same call may overwrite the scenario (latest wins),
 * persist the conversation id, and mark the session ended. No realtime audio is ever stored
 * (FR-025); corrected text is the single source of truth.
 */
export type AppendTurnsOutcome =
  | { ok: true; session: LiveSession }
  | { ok: false; status: 400 | 404; code: string; message: string };

export class TranscriptService {
  constructor(
    private readonly lessons: LessonReader,
    private readonly repo: LiveStoryRepository,
    private readonly logger: Logger = noopLogger,
  ) {}

  async appendTurns(
    ownerId: string,
    lessonId: string,
    req: AppendTurnRequest,
  ): Promise<AppendTurnsOutcome> {
    const log = this.logger.child({ lessonId, ownerId });

    const lesson = await this.lessons.getLesson(ownerId, lessonId);
    if (!lesson) {
      return { ok: false, status: 404, code: "not_found", message: "Lesson not found." };
    }

    const session = await this.repo.getSession(ownerId, req.sessionId);
    if (!session || session.lessonId !== lessonId) {
      return { ok: false, status: 404, code: "not_found", message: "Session not found." };
    }

    if (req.turns.length === 0) {
      return { ok: false, status: 400, code: "invalid_body", message: "At least one turn is required." };
    }
    for (const t of req.turns) {
      if (t.text.trim().length === 0) {
        return { ok: false, status: 400, code: "invalid_body", message: "Turn text cannot be blank." };
      }
      if (!isRoleKindConsistent(t.role, t.kind)) {
        return {
          ok: false,
          status: 400,
          code: "invalid_body",
          message: `Turn role "${t.role}" is inconsistent with kind "${t.kind}".`,
        };
      }
    }

    await this.repo.appendTurns(
      ownerId,
      session.id,
      req.turns.map((t) => ({
        role: t.role,
        kind: t.kind,
        text: t.text,
        elevenTurnRef: t.elevenTurnRef ?? null,
      })),
    );

    if (req.scenario !== undefined) {
      await this.repo.updateScenario(ownerId, session.id, req.scenario);
      log.info("story.scenario", "scenario updated (latest wins)", {});
    }
    if (req.elevenlabsConversationId) {
      await this.repo.setConversationId(ownerId, session.id, req.elevenlabsConversationId);
    }
    if (req.ended) {
      await this.repo.endSession(ownerId, session.id);
    }

    const updated = await this.repo.getSession(ownerId, session.id);
    if (!updated) {
      return { ok: false, status: 404, code: "not_found", message: "Session not found." };
    }

    for (const t of req.turns) {
      log.info("story.turn", `turn (${t.role}/${t.kind})`, {
        role: t.role,
        kind: t.kind,
        // Transcript text is private learner content — debug only (Constitution V).
        ...(log.enabled("debug") ? { text: t.text } : {}),
      });
    }

    return { ok: true, session: toDTO(updated) };
  }

  /** Owner-scoped transcript, or null when the lesson is missing/not-owned (404). */
  async listTranscript(ownerId: string, lessonId: string): Promise<TranscriptDTO | null> {
    const lesson = await this.lessons.getLesson(ownerId, lessonId);
    if (!lesson) return null;
    const sessions = await this.repo.listTranscript(ownerId, lessonId);
    return { sessions: sessions.map(toDTO) };
  }
}

function toDTO(record: LiveSessionRecord): LiveSession {
  return {
    id: record.id,
    lessonId: record.lessonId,
    status: record.status,
    scenario: record.scenario,
    elevenlabsConversationId: record.elevenlabsConversationId,
    turns: record.turns
      .slice()
      .sort((a, b) => a.turnIndex - b.turnIndex)
      .map((t) => ({
        role: t.role,
        kind: t.kind,
        text: t.text,
        turnIndex: t.turnIndex,
        elevenTurnRef: t.elevenTurnRef,
      })),
    createdAt: record.createdAt,
    endedAt: record.endedAt,
  };
}
