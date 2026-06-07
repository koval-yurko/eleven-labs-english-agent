import type { CreateExchangeRequest, QaExchange } from "@idiomatic/contracts";
import { noopLogger, type Logger } from "@idiomatic/generator";
import type { LessonRepository } from "../lessons/repository";
import { buildItemTimeline, resolveItemAtPosition } from "../live-tutor/current-item";
import type { QaExchangeRecord, QaRepository } from "./repository";

/**
 * Captures and lists live-tutor Q&A exchanges (US3). Owner-scoped throughout (FR-018).
 * The relevant item is resolved authoritatively SERVER-SIDE from the interruption
 * position against the lesson script (R3), so the anchor (FR-012) doesn't depend on the
 * client. Persistence is off the answer latency path (the client posts after resume).
 */
export type CreateExchangeOutcome =
  | { ok: true; exchange: QaExchange }
  | { ok: false; status: 400 | 404; code: string; message: string };

export class QaService {
  constructor(
    private readonly lessons: LessonRepository,
    private readonly qa: QaRepository,
    private readonly logger: Logger = noopLogger,
  ) {}

  async createExchange(
    ownerId: string,
    lessonId: string,
    req: CreateExchangeRequest,
  ): Promise<CreateExchangeOutcome> {
    const log = this.logger.child({ lessonId, ownerId });

    const lesson = await this.lessons.getLesson(ownerId, lessonId);
    if (!lesson) {
      return { ok: false, status: 404, code: "not_found", message: "Lesson not found." };
    }
    if (req.turns.length === 0) {
      return { ok: false, status: 400, code: "invalid_body", message: "An exchange needs at least one turn." };
    }

    const items = await this.lessons.getSourceItems(ownerId, lessonId);

    // Resolve the relevant item from the interruption position (authoritative, R3).
    let sourceItemId: string | null = null;
    if (lesson.script) {
      const timeline = buildItemTimeline(lesson.script, items, lesson.audioDurationSeconds);
      sourceItemId = resolveItemAtPosition(timeline, req.interruptionPositionSeconds)?.sourceItemId ?? null;
    }

    const existing = await this.qa.listExchanges(ownerId, lessonId);
    const exchangeIndex = existing.length;

    const record = await this.qa.createExchange({
      lessonId,
      ownerId,
      sourceItemId,
      interruptionPositionSeconds: req.interruptionPositionSeconds,
      exchangeIndex,
      elevenlabsConversationId: req.elevenlabsConversationId ?? null,
      turns: req.turns.map((t) => ({ role: t.role, text: t.text, turnIndex: t.turnIndex })),
    });

    log.info("qa.exchange", "captured Q&A exchange", {
      exchangeIndex,
      sourceItemId,
      turnCount: record.turns.length,
      positionSeconds: req.interruptionPositionSeconds,
    });
    for (const turn of record.turns) {
      log.info("qa.turn", `turn ${turn.turnIndex} (${turn.role})`, {
        role: turn.role,
        turnIndex: turn.turnIndex,
        // Transcript text is private learner content — debug only (Constitution V).
        ...(log.enabled("debug") ? { text: turn.text } : {}),
      });
    }

    return { ok: true, exchange: toDTO(record) };
  }

  /** Owner-scoped list, or null when the lesson is missing/not-owned (404). */
  async listExchanges(ownerId: string, lessonId: string): Promise<QaExchange[] | null> {
    const lesson = await this.lessons.getLesson(ownerId, lessonId);
    if (!lesson) return null;
    const records = await this.qa.listExchanges(ownerId, lessonId);
    return records.map(toDTO);
  }
}

function toDTO(record: QaExchangeRecord): QaExchange {
  return {
    id: record.id,
    lessonId: record.lessonId,
    sourceItemId: record.sourceItemId,
    exchangeIndex: record.exchangeIndex,
    interruptionPositionSeconds: record.interruptionPositionSeconds,
    elevenlabsConversationId: record.elevenlabsConversationId,
    turns: record.turns.map((t) => ({ role: t.role, text: t.text, turnIndex: t.turnIndex })),
    createdAt: record.createdAt,
  };
}
