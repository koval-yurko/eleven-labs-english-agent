import type { LessonPlan, StartStoryToken } from "@idiomatic/contracts";
import { derivePlan, noopLogger, type Logger } from "@idiomatic/generator";
import type { LessonRepository } from "../lessons/repository";
import { mintConversationToken, type TokenFetch } from "../live-tutor/token";
import type { LiveStoryConfig } from "../config";
import { isLiveStoryConfigured } from "./availability";
import { buildPlanDynamicVariables } from "./plan-context";
import type { LiveStoryRepository } from "./repository";

/**
 * Orchestrates starting an adaptive live-story session for a ready, owned lesson (US1).
 * Derives the lesson plan read-only from the persisted LessonScript + source items (R2),
 * mints an owner-scoped conversation token (reusing 005's mint, R10/R1), opens a
 * `LiveSession` row so turns can persist from the first `onMessage` (FR-027), and returns
 * the per-session grounding. Degrades to a clear "unavailable" 503 when the agent is not
 * configured or the mint fails (FR-026, R7). The xi-api-key never leaves this layer.
 */
export type StartStoryOutcome =
  | { ok: true; token: StartStoryToken; plan: LessonPlan }
  | { ok: false; status: 404 | 409 | 503; code: string; message: string };

const UNAVAILABLE_MESSAGE =
  "The live story isn't available right now. Please try again in a little while.";

export class StartStoryService {
  constructor(
    private readonly lessons: LessonRepository,
    private readonly repo: LiveStoryRepository,
    private readonly config: LiveStoryConfig,
    private readonly logger: Logger = noopLogger,
    private readonly fetchImpl: TokenFetch = fetch,
  ) {}

  available(): boolean {
    return isLiveStoryConfigured(this.config);
  }

  async startStory(ownerId: string, lessonId: string): Promise<StartStoryOutcome> {
    const log = this.logger.child({ lessonId, ownerId });

    const lesson = await this.lessons.getLesson(ownerId, lessonId);
    if (!lesson) {
      return { ok: false, status: 404, code: "not_found", message: "Lesson not found." };
    }
    if (lesson.status !== "ready" || !lesson.script) {
      return {
        ok: false,
        status: 409,
        code: "not_ready",
        message: "This lesson isn't ready for a live story yet.",
      };
    }
    if (!this.available()) {
      log.warn("story.unavailable", "live story not configured", { reason: "not_configured" });
      return { ok: false, status: 503, code: "unavailable", message: UNAVAILABLE_MESSAGE };
    }

    const items = await this.lessons.getSourceItems(ownerId, lessonId);

    let plan;
    try {
      plan = derivePlan(lesson.script, items, {
        targetMinSeconds: this.config.targetMinSeconds,
        targetMaxSeconds: this.config.targetMaxSeconds,
      });
      plan = { ...plan, lessonId };
    } catch (err) {
      log.error("story.error", "plan derivation failed", {
        reason: err instanceof Error ? err.message : "unknown",
      });
      return { ok: false, status: 503, code: "unavailable", message: UNAVAILABLE_MESSAGE };
    }

    const dynamicVariables = buildPlanDynamicVariables(plan, null);

    let conversationToken: string;
    let connectionType: "webrtc" | "websocket";
    try {
      const minted = await mintConversationToken(
        this.config.apiKey!,
        this.config.agentId!,
        this.fetchImpl,
      );
      conversationToken = minted.conversationToken;
      connectionType = minted.connectionType;
    } catch (err) {
      // A transient mint outage surfaces the same clear fallback as being unconfigured (R7).
      log.warn("story.unavailable", "conversation token mint failed", {
        reason: err instanceof Error ? err.message : "unknown",
      });
      return { ok: false, status: 503, code: "unavailable", message: UNAVAILABLE_MESSAGE };
    }

    // Open the session AFTER a successful mint so a failed start leaves no orphan row.
    const session = await this.repo.openSession({ lessonId, ownerId, scenario: null });

    log.info("story.session", "opened live-story session", {
      sessionId: session.id,
      connectionType,
    });
    log.info("story.beat", "derived narration plan", { beatCount: plan.beats.length });
    log.info("story.coverage", "coverage target", {
      itemCount: plan.items.length,
      covered: 0,
    });

    return {
      ok: true,
      plan,
      token: {
        sessionId: session.id,
        agentId: this.config.agentId!,
        conversationToken,
        connectionType,
        dynamicVariables,
      },
    };
  }
}
