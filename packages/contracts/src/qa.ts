import { z } from "zod";

/**
 * Live-tutor Q&A boundary schemas (005-live-tutor-qa). Shared between the web app's
 * realtime client (capture), its route handlers (persist/list), and the QA repository.
 * Mirrors specs/005-live-tutor-qa/contracts/qa.schema.json. Ownership is enforced by the
 * repository/RLS (FR-018); these shapes carry no owner_id (it is stamped server-side).
 */

/** A turn is either the learner's question or the tutor's answer (data-model: QaTurn). */
export const QA_TURN_ROLES = ["learner", "tutor"] as const;
export const QaTurnRole = z.enum(QA_TURN_ROLES);
export type QaTurnRole = z.infer<typeof QaTurnRole>;

/** One captured utterance within an exchange (FR-011). */
export const QaTurn = z.object({
  role: QaTurnRole,
  /** Transcript of the utterance. Private learner content (Constitution V). */
  text: z.string().min(1),
  /** 0-based order within the exchange. */
  turnIndex: z.number().int().min(0),
});
export type QaTurn = z.infer<typeof QaTurn>;

/** One interruption-to-resume episode, anchored to a lesson + relevant item (FR-012). */
export const QaExchange = z.object({
  id: z.string(),
  lessonId: z.string(),
  /** Relevant item active at interruption (R3); null if none resolvable (e.g. pre-first item). */
  sourceItemId: z.string().nullable(),
  /** 0-based order of this exchange within the lesson (FR-013). */
  exchangeIndex: z.number().int().min(0),
  /** Exact lesson playback position to resume from (FR-003/FR-010). */
  interruptionPositionSeconds: z.number().min(0),
  /** Realtime conversation id, for reproducibility/debug (Constitution III). */
  elevenlabsConversationId: z.string().nullable(),
  turns: z.array(QaTurn).min(1),
  createdAt: z.string(),
});
export type QaExchange = z.infer<typeof QaExchange>;

/**
 * Payload to persist a completed exchange (POST .../exchanges). `exchangeIndex` is
 * assigned server-side, so it is not part of the request.
 */
export const CreateExchangeRequest = z.object({
  sourceItemId: z.string().nullable().optional(),
  interruptionPositionSeconds: z.number().min(0),
  elevenlabsConversationId: z.string().nullable().optional(),
  turns: z.array(QaTurn).min(1),
});
export type CreateExchangeRequest = z.infer<typeof CreateExchangeRequest>;

/**
 * Owner-scoped credential the browser uses to open a realtime agent session. The
 * ElevenLabs `xi-api-key` NEVER appears here (Constitution V); only a short-lived
 * conversation token does. `dynamicVariables` ground the agent in this lesson (R4).
 */
export const LiveSessionToken = z.object({
  agentId: z.string(),
  conversationToken: z.string(),
  connectionType: z.enum(["webrtc", "websocket"]),
  dynamicVariables: z.record(z.string()),
});
export type LiveSessionToken = z.infer<typeof LiveSessionToken>;

/** Response body for GET .../exchanges (list of captured exchanges, ordered). */
export const ExchangeListDTO = z.object({
  exchanges: z.array(QaExchange),
});
export type ExchangeListDTO = z.infer<typeof ExchangeListDTO>;
