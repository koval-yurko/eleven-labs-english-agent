import { API_V2_ROUTES } from "@tutor/shared/api";

import { apiRequest } from "../../../../lib/api";
import { forward } from "../../../../lib/forward";

/**
 * `POST /api/lessons/session` — the `pagehide` / `freeze` BEACON's target, same-origin on purpose.
 *
 * `navigator.sendBeacon` cannot set an `Authorization` header, so the browser cannot call
 * services/api's `POST /api/v2/lessons/session` itself. It posts here with its session cookie;
 * this forwards the body unchanged with the learner's access token attached. The write, its
 * validation and its owner check all happen in the API. docs/2026-10-10-services-split-hono-api.md
 * §5.2.
 *
 * The beacon never reads the answer; the status is forwarded anyway, for anyone debugging with the
 * network tab open.
 */
export async function POST(req: Request) {
  const res = await apiRequest(API_V2_ROUTES.lessonSession, {
    method: "POST",
    body: await req.text(),
    contentType: "application/json",
  });
  return forward(res);
}
