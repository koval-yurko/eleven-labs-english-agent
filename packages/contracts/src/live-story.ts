import { z } from "zod";
import { ItemType } from "./lesson";

/**
 * Adaptive live-story boundary schemas (006-adaptive-live-story). Shared between the
 * realtime client (narration loop + capture), the route handlers (token mint, transcript
 * persist/review), the pure narration state machine, and the live-story repository.
 * Mirrors specs/006-adaptive-live-story/contracts/live-story.schema.json EXACTLY (no `any`
 * across boundaries; Constitution II). Ownership is enforced by the repository/RLS; these
 * shapes carry no owner_id (it is stamped server-side). No realtime audio appears anywhere
 * (FR-025).
 */

/* ── Lesson plan (derived, not persisted — R2) ────────────────────────────── */

/** One teachable item the narration must cover at least once (FR-004). */
export const PlanItem = z.object({
  sourceItemId: z.string().min(1),
  normalizedText: z.string().min(1),
  itemType: ItemType,
});
export type PlanItem = z.infer<typeof PlanItem>;

/** One ordered story beat condensed from the LessonScript segments (R2). */
export const PlanBeat = z.object({
  index: z.number().int().min(0),
  summary: z.string().min(1),
  /** sourceItemIds taught in this beat; empty for a pure story/connective beat. */
  teachesItemIds: z.array(z.string().min(1)),
});
export type PlanBeat = z.infer<typeof PlanBeat>;

/** Derived (not persisted) ordered plan that drives narration. Reproducible from lessons.script. */
export const LessonPlan = z.object({
  lessonId: z.string().min(1),
  items: z.array(PlanItem).min(1),
  beats: z.array(PlanBeat).min(1),
  targetSeconds: z.number().int().min(1),
  teacherVoiceId: z.string().min(1),
});
export type LessonPlan = z.infer<typeof LessonPlan>;

/* ── Start-session credential (R1/R10) ────────────────────────────────────── */

/**
 * Owner-scoped credential + grounding the browser uses to open a realtime narration
 * session. The `xi-api-key` NEVER appears here (Constitution V); only a short-lived
 * conversation token does.
 */
export const StartStoryToken = z.object({
  /** id of the opened LiveSession row, used for transcript writes. */
  sessionId: z.string(),
  agentId: z.string(),
  conversationToken: z.string(),
  connectionType: z.enum(["webrtc", "websocket"]),
  /** Plan-derived grounding injected at startSession: lesson_summary, items_list, … */
  dynamicVariables: z.record(z.string()),
});
export type StartStoryToken = z.infer<typeof StartStoryToken>;

/* ── Session turns + sessions (the durable transcript) ────────────────────── */

export const SESSION_TURN_ROLES = ["teacher", "learner"] as const;
export const SessionTurnRole = z.enum(SESSION_TURN_ROLES);
export type SessionTurnRole = z.infer<typeof SessionTurnRole>;

export const SESSION_TURN_KINDS = ["narration", "answer", "question", "scenario_change"] as const;
export const SessionTurnKind = z.enum(SESSION_TURN_KINDS);
export type SessionTurnKind = z.infer<typeof SessionTurnKind>;

/**
 * Role/kind consistency (data-model §SessionTurn validation): a `learner` turn is a
 * `question` or a `scenario_change` (the learner requested it); a `teacher` turn is
 * `narration` or an `answer`. Encoded here so the boundary rejects an inconsistent turn.
 */
const TEACHER_KINDS: readonly SessionTurnKind[] = ["narration", "answer"];
const LEARNER_KINDS: readonly SessionTurnKind[] = ["question", "scenario_change"];

export function isRoleKindConsistent(role: SessionTurnRole, kind: SessionTurnKind): boolean {
  return role === "teacher" ? TEACHER_KINDS.includes(kind) : LEARNER_KINDS.includes(kind);
}

const roleKindRefinement = (
  v: { role: SessionTurnRole; kind: SessionTurnKind },
  ctx: z.RefinementCtx,
): void => {
  if (!isRoleKindConsistent(v.role, v.kind)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `role "${v.role}" is inconsistent with kind "${v.kind}"`,
      path: ["kind"],
    });
  }
};

/** One captured utterance, corrected text, attributed and ordered (FR-021/FR-022/FR-023). */
export const SessionTurn = z
  .object({
    role: SessionTurnRole,
    kind: SessionTurnKind,
    /** Corrected transcript (R5). Private learner content. */
    text: z.string().min(1),
    turnIndex: z.number().int().min(0),
    /** Optional SDK turn ref; lets a barge-in correction upsert a teacher turn in place. */
    elevenTurnRef: z.string().nullable().optional(),
  })
  .superRefine(roleKindRefinement);
export type SessionTurn = z.infer<typeof SessionTurn>;

export const LIVE_SESSION_STATUSES = ["active", "ended"] as const;
export const LiveSessionStatus = z.enum(LIVE_SESSION_STATUSES);
export type LiveSessionStatus = z.infer<typeof LiveSessionStatus>;

/** One narration-plus-interaction episode + its ordered turns (the durable record). */
export const LiveSession = z.object({
  id: z.string(),
  lessonId: z.string(),
  status: LiveSessionStatus,
  /** Most recent scenario in effect; null = original setting (FR-008/FR-009). */
  scenario: z.string().nullable(),
  elevenlabsConversationId: z.string().nullable(),
  turns: z.array(SessionTurn),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type LiveSession = z.infer<typeof LiveSession>;

/**
 * Append one or more finalized turns to a session (incremental persistence; off the speech
 * path; FR-027). `turnIndex` is assigned/validated server-side as the next index. May also
 * update the session's scenario / mark it ended.
 */
export const AppendTurnRequest = z.object({
  sessionId: z.string(),
  turns: z
    .array(
      z
        .object({
          role: SessionTurnRole,
          kind: SessionTurnKind,
          text: z.string().min(1),
          elevenTurnRef: z.string().nullable().optional(),
        })
        .superRefine(roleKindRefinement),
    )
    .min(1),
  /** Set/overwrite the session's current scenario (latest wins). */
  scenario: z.string().nullable().optional(),
  /** When true, mark the session ended (status=ended, ended_at=now). */
  ended: z.boolean().optional(),
  elevenlabsConversationId: z.string().nullable().optional(),
});
export type AppendTurnRequest = z.infer<typeof AppendTurnRequest>;

/** Response body for GET .../transcript — the lesson's live sessions, most recent first. */
export const TranscriptDTO = z.object({
  sessions: z.array(LiveSession),
});
export type TranscriptDTO = z.infer<typeof TranscriptDTO>;

/* ── Client-tool I/O (R1/R3/R4) ───────────────────────────────────────────── */

/** `markItemTaught(itemId)` — adds a planned item to the covered set (R3). */
export const MarkItemTaughtParams = z.object({ itemId: z.string().min(1) });
export type MarkItemTaughtParams = z.infer<typeof MarkItemTaughtParams>;

/** `setScenario(scenario)` — the learner-requested new story setting (R4). */
export const SetScenarioParams = z.object({ scenario: z.string().min(1) });
export type SetScenarioParams = z.infer<typeof SetScenarioParams>;

/** Every client tool returns a short human-readable instruction string the agent continues from. */
export const ClientToolResult = z.string();
export type ClientToolResult = z.infer<typeof ClientToolResult>;
