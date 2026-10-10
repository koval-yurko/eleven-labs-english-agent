/**
 * `services/api` — the HTTP API on Hono. docs/2026-10-10-services-split-hono-api.md §4.
 *
 * Hono does the routing and nothing else. Each route module under `routes/` exports Web-standard
 * handlers named after their methods (`GET`, `POST`, …, `OPTIONS`) with the signature the Next app
 * used — `(req: Request, ctx: { params: Promise<…> }) => Promise<Response>` — so a route ported
 * from the Next app's `src/app/api` (apps/web, deleted at the cutover) kept its body, its auth
 * wrapper and its responses unchanged, and the port could be reviewed as a diff. `TABLE` below is
 * the whole URL space.
 *
 * Two rules the table keeps:
 *   - Static paths before `:id` paths, so `/lessons/session` is never read as lesson "session".
 *   - A method a route does not export answers 405, as Next did — not Hono's 404. Unlike Next it
 *     also sends `Allow`, which RFC 9110 §15.5.6 requires on a 405 (the one header parity skips).
 */
import { Hono, type Context } from "hono";

import * as health from "./routes/health/route";
import * as mcp from "./routes/mcp/route";
import * as agentVersions from "./routes/v2/agent-versions/route";
import * as debugReports from "./routes/v2/debug-reports/route";
import * as itemDelete from "./routes/v2/lesson-items/delete/route";
import * as itemPopularity from "./routes/v2/lesson-items/popularity/route";
import * as items from "./routes/v2/lesson-items/route";
import * as itemById from "./routes/v2/lesson-items/[id]/route";
import * as lessonSession from "./routes/v2/lessons/session/route";
import * as lessons from "./routes/v2/lessons/route";
import * as lessonById from "./routes/v2/lessons/[id]/route";
import * as lessonItems from "./routes/v2/lessons/[id]/items/route";
import * as suggest from "./routes/v2/lexicon/suggest/route";
import * as livekitCollectionItems from "./routes/v2/livekit/collection-items/route";
import * as livekitSessionEnd from "./routes/v2/livekit/session-end/route";
import * as me from "./routes/v2/me/route";
import * as opsArchiveResolved from "./routes/v2/ops/debug-reports/archive-resolved/route";
import * as opsReports from "./routes/v2/ops/debug-reports/route";
import * as opsReportById from "./routes/v2/ops/debug-reports/[id]/route";
import * as syncFlush from "./routes/v2/sync/flush/route";
import * as vapiWebhook from "./routes/v2/vapi/webhook/route";
import * as livekitToken from "./routes/v2/words-agent/livekit-token/route";
import * as openaiToken from "./routes/v2/words-agent/openai-token/route";
import * as signedUrl from "./routes/v2/words-agent/signed-url/route";
import * as conversationToken from "./routes/v2/words-agent/token/route";
import * as vapiToken from "./routes/v2/words-agent/vapi-token/route";
import * as elevenLabsWebhook from "./routes/words-agent/elevenlabs-webhook/route";

type RouteCtx = { params: Promise<Record<string, string>> };
type Handler = (req: Request, ctx: RouteCtx) => Promise<Response> | Response;

const METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] as const;

/** Path (Hono syntax) → route module. Order matters: static segments before `:id`. */
const TABLE: [path: string, module: object][] = [
  ["/api/health", health],
  ["/api/mcp", mcp],
  ["/api/words-agent/elevenlabs-webhook", elevenLabsWebhook],

  ["/api/v2/me", me],
  ["/api/v2/agent-versions", agentVersions],
  ["/api/v2/debug-reports", debugReports],

  ["/api/v2/words-agent/token", conversationToken],
  ["/api/v2/words-agent/signed-url", signedUrl],
  ["/api/v2/words-agent/openai-token", openaiToken],
  ["/api/v2/words-agent/vapi-token", vapiToken],
  ["/api/v2/words-agent/livekit-token", livekitToken],
  ["/api/v2/vapi/webhook", vapiWebhook],
  ["/api/v2/livekit/session-end", livekitSessionEnd],
  ["/api/v2/livekit/collection-items", livekitCollectionItems],

  ["/api/v2/lessons", lessons],
  ["/api/v2/lessons/session", lessonSession],
  ["/api/v2/lessons/:id", lessonById],
  ["/api/v2/lessons/:id/items", lessonItems],

  ["/api/v2/lesson-items", items],
  ["/api/v2/lesson-items/delete", itemDelete],
  ["/api/v2/lesson-items/popularity", itemPopularity],
  ["/api/v2/lesson-items/:id", itemById],

  ["/api/v2/lexicon/suggest", suggest],
  ["/api/v2/sync/flush", syncFlush],

  ["/api/v2/ops/debug-reports", opsReports],
  ["/api/v2/ops/debug-reports/archive-resolved", opsArchiveResolved],
  ["/api/v2/ops/debug-reports/:id", opsReportById],
];

function handlersOf(module: object): Partial<Record<(typeof METHODS)[number], Handler>> {
  const out: Partial<Record<(typeof METHODS)[number], Handler>> = {};
  for (const m of METHODS) {
    const h = (module as Record<string, unknown>)[m];
    if (typeof h === "function") out[m] = h as Handler;
  }
  return out;
}

/** Hand the ported handler what Next did: the raw Request, and params behind a promise. */
const adapt = (handler: Handler) => (c: Context) =>
  handler(c.req.raw, { params: Promise.resolve(c.req.param() as Record<string, string>) });

export function createApp(): Hono {
  const app = new Hono();

  for (const [path, module] of TABLE) {
    const handlers = handlersOf(module);
    const allowed = Object.keys(handlers);
    for (const [method, handler] of Object.entries(handlers)) {
      app.on(method, path, adapt(handler as Handler));
    }
    // Registered after the real methods, so it only answers the ones the route does not export.
    app.all(path, () => new Response(null, { status: 405, headers: { allow: allowed.join(", ") } }));
  }

  return app;
}

export default createApp();
