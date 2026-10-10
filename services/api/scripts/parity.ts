/**
 * Parity check for the Hono port (step 3 of docs/2026-10-10-services-split-hono-api.md): the same
 * request against two API deployments, compared. Built for old Next API vs Hono API; after the
 * repo cutover its use is the deploy cutover — today's production (still the Next build until the
 * Vercel Root Directory changes) against a `services/api` preview:
 *
 *   pnpm parity:api --old https://<production> --new https://<preview>
 *   pnpm parity:api --old … --new … --token-file <file with an Auth0 access token>   # + authenticated reads
 *   (or PARITY_TOKEN=<token>)
 *
 * Both URLs are required: there is no local baseline any more (`apps/web` is deleted).
 *
 * READ-ONLY BY CONSTRUCTION. Both servers talk to the same (production) database, so no case here
 * sends a write that could succeed: every POST is either unauthenticated, unsigned, or malformed
 * on purpose, and the authenticated tier is GETs only. Writes are covered by the mobile end-to-end
 * run against a preview deployment, not here.
 *
 * Tiers:
 *   1. Always: auth failures, CORS preflights, 405s, webhook/MCP/grant rejections, health's shape.
 *   2. With PARITY_TOKEN: every authenticated GET the mobile app makes, deep-compared.
 *   3. New-only: the `/api/v2/ops/debug-reports` endpoints have no Next counterpart — checked for
 *      status and shape on the new server (needs PARITY_TOKEN).
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    old: { type: "string" },
    new: { type: "string" },
    /** A file holding the access token — keeps it out of shell history and `ps`. */
    "token-file": { type: "string" },
  },
});
if (!values.old || !values.new) {
  console.error("usage: pnpm parity:api --old <base url> --new <base url> [--token-file <file>]");
  process.exit(2);
}
const OLD = values.old.replace(/\/+$/, "");
const NEW = values.new.replace(/\/+$/, "");
const TOKEN =
  (values["token-file"] ? readFileSync(values["token-file"], "utf8") : process.env.PARITY_TOKEN)
    ?.trim() || null;

/** The response headers whose difference would be a behaviour change. Everything else is noise. */
const COMPARED_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
  "www-authenticate",
  "allow",
  "cache-control",
];

interface Case {
  name: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** How bodies are compared. `exact` = deep-equal JSON; `shape` = same keys, recursively. */
  compare?: "exact" | "shape" | "status";
  /** Paths in the JSON body to ignore (dot-separated), for values that legitimately differ. */
  ignore?: string[];
  /** Headers to skip comparing for this case. */
  ignoreHeaders?: string[];
}

interface Snapshot {
  status: number;
  headers: Record<string, string | null>;
  body: unknown;
}

async function hit(base: string, c: Case): Promise<Snapshot> {
  const res = await fetch(base + c.path, {
    method: c.method ?? "GET",
    headers: c.headers,
    body: c.body,
    redirect: "manual",
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON stays text.
  }
  const headers: Record<string, string | null> = {};
  for (const h of COMPARED_HEADERS) headers[h] = res.headers.get(h);
  return { status: res.status, headers, body };
}

function strip(value: unknown, ignore: string[], prefix = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => strip(v, ignore, prefix));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (ignore.includes(path)) continue;
      out[k] = strip((value as Record<string, unknown>)[k], ignore, path);
    }
    return out;
  }
  return value;
}

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = shape((value as Record<string, unknown>)[k]);
    return out;
  }
  return value === null ? "null" : typeof value;
}

const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

async function compare(c: Case): Promise<void> {
  const [a, b] = await Promise.all([hit(OLD, c), hit(NEW, c)]);
  const problems: string[] = [];
  if (a.status !== b.status) problems.push(`status ${a.status} → ${b.status}`);
  for (const h of COMPARED_HEADERS) {
    if (c.ignoreHeaders?.includes(h)) continue;
    if (a.headers[h] !== b.headers[h]) problems.push(`${h}: ${a.headers[h]} → ${b.headers[h]}`);
  }
  const mode = c.compare ?? "exact";
  if (mode !== "status") {
    const ignore = c.ignore ?? [];
    const left = mode === "shape" ? shape(strip(a.body, ignore)) : strip(a.body, ignore);
    const right = mode === "shape" ? shape(strip(b.body, ignore)) : strip(b.body, ignore);
    const l = JSON.stringify(left);
    const r = JSON.stringify(right);
    if (l !== r) problems.push(`body differs:\n      old ${l.slice(0, 300)}\n      new ${r.slice(0, 300)}`);
  }
  record(`${c.method ?? "GET"} ${c.path}  [${mode}]`, problems.length === 0, problems.join("; "));
}

// ── tier 1: no credentials ─────────────────────────────────────────────────────────────────────

const V2_GET = ["/api/v2/me", "/api/v2/agent-versions", "/api/v2/lessons", "/api/v2/lesson-items"];
const V2_POST = [
  "/api/v2/words-agent/token",
  "/api/v2/words-agent/openai-token",
  "/api/v2/words-agent/vapi-token",
  "/api/v2/words-agent/livekit-token",
  "/api/v2/lessons/session",
  "/api/v2/sync/flush",
  "/api/v2/lesson-items/popularity",
  "/api/v2/lesson-items/delete",
  "/api/v2/debug-reports",
];
const PREFLIGHT = [
  ...V2_GET,
  ...V2_POST,
  "/api/v2/lessons/abc",
  "/api/v2/lessons/abc/items",
  "/api/v2/lesson-items/abc",
  "/api/v2/lexicon/suggest",
  "/api/v2/livekit/session-end",
  "/api/v2/livekit/collection-items",
];

const tier1: Case[] = [
  ...V2_GET.map((path) => ({ name: "", path })),
  ...V2_GET.map((path) => ({ name: "", path, headers: { authorization: "Bearer not-a-jwt" } })),
  ...V2_POST.map((path) => ({
    name: "",
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    body: "{}",
  })),
  { name: "", path: "/api/v2/lessons/abc" },
  { name: "", path: "/api/v2/lessons/abc/items" },
  { name: "", path: "/api/v2/lesson-items/abc" },
  { name: "", path: "/api/v2/lexicon/suggest?q=ab" },
  ...PREFLIGHT.map((path) => ({ name: "", method: "OPTIONS", path, compare: "exact" as const })),
  // Method not exported → 405. Next sends no `Allow`; Hono sends it, as RFC 9110 requires — the
  // one intended header difference.
  ...[
    { method: "GET", path: "/api/v2/words-agent/token" },
    { method: "DELETE", path: "/api/v2/lessons" },
  ].map((c) => ({ name: "", ...c, compare: "status" as const, ignoreHeaders: ["allow"] })),
  // Grant-authenticated worker routes, without a grant.
  ...["/api/v2/livekit/session-end", "/api/v2/livekit/collection-items"].map((path) => ({
    name: "",
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    body: "{}",
  })),
  // Webhooks, unsigned. Never reaches a write: the signature check is first.
  {
    name: "",
    method: "POST",
    path: "/api/words-agent/elevenlabs-webhook",
    headers: { "content-type": "application/json" },
    body: "{}",
  },
  // Signed, but with a stale timestamp: gets past the header check into the ElevenLabs SDK's
  // `constructEvent` — which on services/api is a LAZY import of an external package, so this is
  // the case that proves the deployed function can still load it. Rejected before any write.
  {
    name: "",
    method: "POST",
    path: "/api/words-agent/elevenlabs-webhook",
    headers: {
      "content-type": "application/json",
      "elevenlabs-signature": "t=1700000000,v0=deadbeef",
    },
    body: JSON.stringify({ type: "post_call_transcription" }),
  },
  {
    name: "",
    method: "POST",
    path: "/api/v2/vapi/webhook",
    headers: { "content-type": "application/json" },
    body: "{}",
  },
  // MCP without its token.
  {
    name: "",
    method: "POST",
    path: "/api/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  },
  // Health: live latencies and the auth line differ by design (cookie → bearer, D12).
  { name: "", path: "/api/health", compare: "shape", ignore: ["auth.detail"] },
];

// ── tier 2: authenticated reads ──────────────────────────────────────────────────────────────

async function tier2(): Promise<Case[]> {
  if (!TOKEN) return [];
  const auth = { authorization: `Bearer ${TOKEN}` };
  const cases: Case[] = [
    { name: "", path: "/api/v2/me", headers: auth },
    { name: "", path: "/api/v2/agent-versions", headers: auth },
    { name: "", path: "/api/v2/lessons", headers: auth },
    { name: "", path: "/api/v2/lesson-items", headers: auth },
    { name: "", path: "/api/v2/lesson-items?sort=alpha", headers: auth },
    { name: "", path: "/api/v2/lexicon/suggest?q=ab&limit=8", headers: auth },
    { name: "", path: "/api/v2/lessons/00000000-0000-0000-0000-000000000000", headers: auth },
  ];
  // Real ids, taken from the new server's own answers so the detail routes are exercised too.
  const lessons = (await (await fetch(`${NEW}/api/v2/lessons`, { headers: auth })).json()) as {
    lessons?: { id: string }[];
  };
  const lessonId = lessons.lessons?.[0]?.id;
  if (lessonId) {
    cases.push({ name: "", path: `/api/v2/lessons/${lessonId}`, headers: auth });
    cases.push({ name: "", path: `/api/v2/lessons/${lessonId}/items`, headers: auth });
  }
  const items = (await (await fetch(`${NEW}/api/v2/lesson-items`, { headers: auth })).json()) as {
    items?: { id: string }[];
  };
  const itemId = items.items?.[0]?.id;
  if (itemId) cases.push({ name: "", path: `/api/v2/lesson-items/${itemId}`, headers: auth });
  return cases;
}

// ── tier 3: new-only ops endpoints ───────────────────────────────────────────────────────────

async function tier3(): Promise<void> {
  const unauth = await fetch(`${NEW}/api/v2/ops/debug-reports`);
  record("NEW GET /api/v2/ops/debug-reports without token → 401, no CORS", unauth.status === 401 &&
    unauth.headers.get("access-control-allow-origin") === null, `status ${unauth.status}`);
  const preflight = await fetch(`${NEW}/api/v2/ops/debug-reports`, { method: "OPTIONS" });
  record("NEW OPTIONS /api/v2/ops/debug-reports → 405 (server-to-server only)",
    preflight.status === 405, `status ${preflight.status}`);
  if (!TOKEN) return;

  const auth = { authorization: `Bearer ${TOKEN}` };
  const list = await fetch(`${NEW}/api/v2/ops/debug-reports?scope=all`, { headers: auth });
  const body = (await list.json()) as {
    reports?: { id: string; owner_id: string }[];
    facets?: unknown;
    resolvedActive?: number;
  };
  record("NEW GET /api/v2/ops/debug-reports → 200 with reports/facets/resolvedActive",
    list.status === 200 && Array.isArray(body.reports) && Boolean(body.facets) &&
      typeof body.resolvedActive === "number",
    `status ${list.status}, ${body.reports?.length ?? 0} reports`);
  const first = body.reports?.[0];
  if (first) {
    record("NEW list rows carry owner_id", typeof first.owner_id === "string", first.owner_id);
    const detail = await fetch(`${NEW}/api/v2/ops/debug-reports/${first.id}`, { headers: auth });
    const d = (await detail.json()) as Record<string, unknown>;
    const keys = ["report", "session", "links", "agent", "verdicts", "diagnosis"];
    record(`NEW GET /api/v2/ops/debug-reports/${first.id.slice(0, 8)}… → 200 with ${keys.join("/")}`,
      detail.status === 200 && keys.every((k) => k in d), `status ${detail.status}`);
  }
  const missing = await fetch(
    `${NEW}/api/v2/ops/debug-reports/00000000-0000-0000-0000-000000000000`,
    { headers: auth },
  );
  record("NEW GET unknown report → 404", missing.status === 404, `status ${missing.status}`);
  const badPatch = await fetch(`${NEW}/api/v2/ops/debug-reports/00000000-0000-0000-0000-000000000000`, {
    method: "PATCH",
    headers: { ...auth, "content-type": "application/json" },
    body: "{}",
  });
  record("NEW PATCH with nothing to change → 400 (no write)", badPatch.status === 400,
    `status ${badPatch.status}`);
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────

console.log(`parity: old ${OLD}  vs  new ${NEW}${TOKEN ? "  (with PARITY_TOKEN)" : "  (no token: tier 1 + 3 only)"}\n`);
for (const c of [...tier1, ...(await tier2())]) await compare(c);
await tier3();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : `\n      ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
