import { CreateExchangeRequest } from "@idiomatic/contracts";
import { getOwnerId } from "../../../../../lib/auth/session";
import { getQaService } from "../../../../../lib/container";
import { apiError, json, notFound, unauthorized } from "../../../../../lib/http";

/**
 * POST /api/lessons/{id}/exchanges — persist one completed Q&A exchange + ordered turns
 * (T032, US3). Called AFTER resume, off the answer latency path. The relevant item is
 * resolved server-side from the interruption position (FR-012); 201 returns the stored
 * exchange.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const { id } = await ctx.params;

  let parsed: ReturnType<typeof CreateExchangeRequest.safeParse>;
  try {
    parsed = CreateExchangeRequest.safeParse(await request.json());
  } catch {
    return apiError(400, "invalid_body", "Request body must be valid JSON.");
  }
  if (!parsed.success) {
    return apiError(400, "invalid_body", "Exchange payload is invalid.");
  }

  const outcome = await getQaService().createExchange(ownerId, id, parsed.data);
  if (!outcome.ok) return apiError(outcome.status, outcome.code, outcome.message);
  return json(outcome.exchange, 201);
}

/**
 * GET /api/lessons/{id}/exchanges — list a lesson's captured exchanges, ordered (US3).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  if (!ownerId) return unauthorized();

  const { id } = await ctx.params;
  const exchanges = await getQaService().listExchanges(ownerId, id);
  if (exchanges === null) return notFound(); // missing OR not owned — no existence leak

  return json({ exchanges });
}
