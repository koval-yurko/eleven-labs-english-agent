import { AppendTurnRequest } from "@idiomatic/contracts";
import { getOwnerId } from "../../../../../../lib/auth/session";
import { getTranscriptService } from "../../../../../../lib/container";
import { apiError, json, unauthorized } from "../../../../../../lib/http";

/**
 * POST /api/lessons/{id}/live-story/turns — append finalized turn(s) to a session (T043,
 * US5). Called as `onMessage`/`onAgentResponseCorrection` fire — incremental, OFF the speech
 * path (FR-027). Validates ownership + that the session belongs to the lesson; assigns
 * turnIndex server-side; upserts a teacher turn in place on barge-in correction (R5/R6); may
 * also overwrite the scenario, persist the conversation id, and mark the session ended.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const { id } = await ctx.params;

  let parsed: ReturnType<typeof AppendTurnRequest.safeParse>;
  try {
    parsed = AppendTurnRequest.safeParse(await request.json());
  } catch {
    return apiError(400, "invalid_body", "Request body must be valid JSON.");
  }
  if (!parsed.success) {
    return apiError(400, "invalid_body", "Turn payload is invalid.");
  }

  const outcome = await getTranscriptService().appendTurns(ownerId, id, parsed.data);
  if (!outcome.ok) return apiError(outcome.status, outcome.code, outcome.message);
  return json(outcome.session, 201);
}
