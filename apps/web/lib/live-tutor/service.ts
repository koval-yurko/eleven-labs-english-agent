import type { LiveSessionToken } from "@idiomatic/contracts";
import { noopLogger, type Logger } from "@idiomatic/generator";
import type { LessonRepository } from "../lessons/repository";
import type { LiveTutorConfig } from "./availability";
import { isLiveTutorConfigured } from "./availability";
import { buildDynamicVariables } from "./context";
import { buildItemTimeline, resolveItemAtPosition } from "./current-item";
import { mintConversationToken, type TokenFetch } from "./token";

/**
 * Orchestrates starting a live-tutor session for a ready, owned lesson (US1). Reads the
 * lesson's script + items to ground the agent (R4), mints an owner-scoped conversation
 * token (R1), and degrades to a clear "unavailable" outcome when the agent is not
 * configured or the mint fails (FR-017). The xi-api-key never leaves this layer.
 */
export type StartSessionOutcome =
  | { ok: true; token: LiveSessionToken }
  | { ok: false; status: 404 | 409 | 503; code: string; message: string };

const UNAVAILABLE_MESSAGE =
  "Live tutor isn't available right now. Keep listening and try again later.";

export class LiveTutorService {
  constructor(
    private readonly repo: LessonRepository,
    private readonly config: LiveTutorConfig,
    private readonly logger: Logger = noopLogger,
    private readonly fetchImpl: TokenFetch = fetch,
  ) {}

  available(): boolean {
    return isLiveTutorConfigured(this.config);
  }

  async startSession(
    ownerId: string,
    lessonId: string,
    currentPositionSeconds?: number,
  ): Promise<StartSessionOutcome> {
    const log = this.logger.child({ lessonId, ownerId });

    const lesson = await this.repo.getLesson(ownerId, lessonId);
    if (!lesson) {
      return { ok: false, status: 404, code: "not_found", message: "Lesson not found." };
    }
    if (lesson.status !== "ready" || !lesson.script) {
      return {
        ok: false,
        status: 409,
        code: "not_ready",
        message: "This lesson isn't ready for live Q&A yet.",
      };
    }
    if (!this.available()) {
      log.warn("qa.unavailable", "live tutor not configured", { reason: "not_configured" });
      return { ok: false, status: 503, code: "unavailable", message: UNAVAILABLE_MESSAGE };
    }

    const items = await this.repo.getSourceItems(ownerId, lessonId);
    let currentItemText: string | undefined;
    if (typeof currentPositionSeconds === "number") {
      const timeline = buildItemTimeline(lesson.script, items, lesson.audioDurationSeconds);
      currentItemText = resolveItemAtPosition(timeline, currentPositionSeconds)?.normalizedText;
    }
    const dynamicVariables = buildDynamicVariables(lesson.script, items, currentItemText);

    try {
      const minted = await mintConversationToken(
        this.config.apiKey!,
        this.config.agentId!,
        this.fetchImpl,
      );
      log.info("qa.session", "minted live session token", {
        connectionType: minted.connectionType,
      });
      return {
        ok: true,
        token: {
          agentId: this.config.agentId!,
          conversationToken: minted.conversationToken,
          connectionType: minted.connectionType,
          dynamicVariables,
        },
      };
    } catch (err) {
      log.error("qa.error", "conversation token mint failed", {
        reason: err instanceof Error ? err.message : "unknown",
      });
      return { ok: false, status: 503, code: "unavailable", message: UNAVAILABLE_MESSAGE };
    }
  }
}
