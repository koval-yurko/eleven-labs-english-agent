import { getBearerOwnerId } from "@tutor/server/auth/bearer";

import { unauthorized, withCors } from "../http";

/**
 * Wrap a v2 route handler so it cannot be written without an authenticated owner.
 *
 * A wrapper rather than a per-route call, deliberately: a route that forgot the check would serve
 * another learner's rows, it would fail OPEN, and it would look finished. Here the handler's
 * signature makes "forgot to authenticate" inexpressible.
 *
 * Kept as a wrapper in the Hono port too, rather than router middleware: the handler signature is
 * the guarantee, and it is the one the route bodies ported from `apps/web` were written against.
 *
 * It is also the single place CORS is applied (D25) — including to the 401, so a browser sees the
 * status rather than an opaque network error. Routes still export `OPTIONS = preflight` for the
 * preflight itself, which never reaches a handler.
 *
 * `Ctx` is the route context `app.ts` passes: `{ params: Promise<Record<string, string>> }`, the
 * same shape Next handed a dynamic route, so ported handlers read their id unchanged.
 */
export function withBearer<Ctx = undefined>(
  handler: (req: Request, ownerId: string, ctx: Ctx) => Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req: Request, ctx: Ctx) => {
    const ownerId = await getBearerOwnerId(req);
    if (!ownerId) return withCors(unauthorized());
    return withCors(await handler(req, ownerId, ctx));
  };
}

/**
 * `withBearer` without CORS — for routes only a server calls (`/api/v2/ops/*`, from
 * feedback-tracker's own server side). No browser should ever reach them, so none is told it may.
 */
export function withServerBearer<Ctx = undefined>(
  handler: (req: Request, ownerId: string, ctx: Ctx) => Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req: Request, ctx: Ctx) => {
    const ownerId = await getBearerOwnerId(req);
    if (!ownerId) return unauthorized();
    return handler(req, ownerId, ctx);
  };
}
