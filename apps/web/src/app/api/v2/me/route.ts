import type { MeResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../lib/auth/bearer";
import { json } from "../../../../lib/http";

/**
 * `GET /api/v2/me` — the authenticated learner's Auth0 `sub`.
 *
 * It exists to make S2's gate unambiguous: if this returns the same `sub` the web app shows for the
 * same account, then the whole Bearer path works and every owner-scoped v2 route added later
 * inherits it. Afterwards it stays useful as an auth/liveness probe.
 *
 * The body is assigned to the declared shared type before returning, so a drifted field is a
 * typecheck failure here rather than a runtime `undefined` on a shipped phone.
 */
export const GET = withBearer(async (_req, ownerId) => {
  const body: MeResponse = { sub: ownerId };
  return json(body);
});
