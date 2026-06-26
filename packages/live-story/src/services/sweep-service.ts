import { noopLogger, noopSessionTracer, type Logger, type SessionTracer } from "@idiomatic/generator";
import type { LiveStoryRepository } from "../persistence/repository";

/**
 * Abandonment sweep (008-langsmith-tracing, US2). A scheduled finalizer that closes live-story
 * sessions which disconnected without a clean `ended` append, so none freeze `active` forever
 * (FR-003, SC-002). For each stale session it: marks it ended and records a FINALIZED trace
 * tagged `termination_reason: "abandoned"` (so abandoned vs. completed is distinguishable).
 *
 * Idempotent (FR-009): a session a late webhook/clean-end already closed is re-checked and
 * skipped, so the sweep reconciles to a single finalized trace. Best-effort per session — one
 * failure never aborts the batch.
 */

export interface SweepInput {
  /** Current time (injected for testability). */
  now: Date;
  /** Sessions idle longer than this are force-closed (FR-003, clarification Q1: 10). */
  idleMinutes: number;
  /** Max sessions finalized this run; the rest are caught next tick. */
  limit: number;
}

export interface SweepResult {
  scanned: number;
  finalized: number;
}

export class SweepService {
  constructor(
    private readonly repo: LiveStoryRepository,
    private readonly tracer: SessionTracer = noopSessionTracer,
    private readonly logger: Logger = noopLogger,
  ) {}

  async sweep({ now, idleMinutes, limit }: SweepInput): Promise<SweepResult> {
    const cutoff = new Date(now.getTime() - idleMinutes * 60_000);
    const stale = await this.repo.findStaleActiveSessions(cutoff, limit);

    let finalized = 0;
    for (const c of stale) {
      try {
        const session = await this.repo.getSession(c.ownerId, c.sessionId);
        // Idempotent: a late clean-end/webhook may have closed it between query and now (FR-009).
        if (!session || session.status !== "active") continue;

        await this.repo.endSession(c.ownerId, c.sessionId);

        await this.tracer.recordSession({
          sessionId: session.id,
          lessonId: session.lessonId,
          ownerId: session.ownerId,
          scenario: session.scenario,
          status: "ended",
          createdAt: session.createdAt,
          terminationReason: "abandoned",
          turns: session.turns.map((t) => ({
            role: t.role,
            kind: t.kind,
            text: t.text,
            turnIndex: t.turnIndex,
          })),
          // A 0-turn session never opened a run (the tracer fires on append) — create it now.
          isNew: session.turns.length === 0,
          ended: true,
        });

        finalized += 1;
        this.logger.info("story.sweep", "swept abandoned session", {
          sessionId: session.id,
          lessonId: session.lessonId,
          turnCount: session.turns.length,
        });
      } catch {
        // Best-effort: a single failure must not abort the rest of the batch.
        this.logger.warn("story.error", "sweep: failed to finalize session", {
          sessionId: c.sessionId,
        });
      }
    }

    return { scanned: stale.length, finalized };
  }
}
