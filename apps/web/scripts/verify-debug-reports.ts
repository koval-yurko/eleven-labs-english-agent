// Exercise the debug-report data layer end to end against the real database, then clean up.
//
// Not a test suite — the repo has no runner — and not part of any gate. It exists because §12's
// gate ("a report filed on the phone is fully explicable from the web page alone") needs a report
// to exist before the page can be looked at, and seeding one by hand in the Supabase console is
// exactly the workflow the operator page was built to replace.
//
// It inserts ONE row, reads it back through every function `/ops/reports` uses, prints what the
// page would render, and deletes it again unless told to keep it.
//
// Usage:
//   pnpm --filter web verify:reports          insert, verify, delete
//   pnpm --filter web verify:reports --keep   leave the row behind, to look at the page
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env.local", ".env"]) dotenv.config({ path: join(root, file) });

const { getServiceSupabase, hasSupabaseEnv } = await import("../src/lib/supabase/server");
const {
  RESOLVED_STATUS,
  debugReportFacets,
  deleteDebugReport,
  getDebugReport,
  getSessionForConversation,
  insertDebugReport,
  listDebugReports,
  setDebugReportTriage,
} = await import("../src/lib/debug-reports");
const { langsmithTraceName, langsmithTraceUrl, providerConsoleUrl, resolveReportAgent } =
  await import("../src/lib/debug-report-links");
const { sanitizeDebugReport } = await import("@tutor/shared/debug/report");

if (!hasSupabaseEnv()) {
  console.error("✗ Supabase env not configured.");
  process.exit(1);
}

const keep = process.argv.includes("--keep");

// The owner with data. Taken from the database rather than hard-coded, so this works on any copy.
const { data: owners } = await getServiceSupabase()
  .from("lessons")
  .select("owner_id")
  .limit(1)
  .maybeSingle();
const ownerId = (owners as { owner_id: string } | null)?.owner_id;
if (!ownerId) {
  console.error("✗ No lessons in this database — nothing to join a report to.");
  process.exit(1);
}

// A real lesson and a real conversation, so the transcript join is exercised rather than mocked.
const { data: joinTarget } = await getServiceSupabase()
  .from("lesson_sessions")
  .select("lesson_id, conversation_id, agent_version")
  .eq("owner_id", ownerId)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
const target = joinTarget as
  | { lesson_id: string; conversation_id: string; agent_version: string | null }
  | null;

const snapshot = (over: Record<string, unknown> = {}) => ({
  focusedLesson: target?.lesson_id ?? null,
  conversationLesson: null,
  conversationId: null,
  savedFor: null,
  owns: false,
  starting: false,
  kickedOff: false,
  status: "disconnected",
  provider: "elevenlabs",
  version: null,
  held: false,
  silenced: true,
  muted: false,
  speaking: false,
  lines: 0,
  carried: 0,
  usage: null,
  holdSnapshot: null,
  resumeCause: null,
  resumeLines: 0,
  heartbeat: false,
  capabilities: { silenceOutput: true, userActivity: true, cancelTurn: false, responseCorrection: true },
  restoreToken: 2,
  metaTitle: "Phrasal verbs",
  lastError: null,
  ...over,
});

// The 2026-08-20 quota outage, as a report: a mint that answered, a connect that did not, and a
// `seq` gap between them so the timeline's "events dropped" marker is exercised too.
const report = sanitizeDebugReport({
  kind: "error",
  note: "VERIFICATION ROW — pressed Start and the tutor never said anything.",
  lessonId: target?.lesson_id ?? null,
  conversationId: target?.conversation_id ?? null,
  provider: "elevenlabs",
  agentVersion: target?.agent_version ?? null,
  errorCode: "transport.error",
  errorMessage: "Server error: Unknown error (quota_exceeded · code 1008)",
  client: {
    appVersion: "1.0.0",
    buildNumber: "42",
    variant: "preview",
    platform: "ios",
    osVersion: "26.1",
    deviceModel: "iPhone 15 Pro",
    apiBaseUrl: "https://example.vercel.app",
    online: true,
  },
  state: {
    live: snapshot(),
    // The frozen copy: connected-ish, owning a conversation, and pointing at a DIFFERENT lesson —
    // so the inconsistency list and the live/atError diff both have something to say.
    atError: snapshot({
      conversationLesson: "aaaaaaaa-0000-4000-8000-000000000000",
      conversationId: target?.conversation_id ?? null,
      owns: true,
      status: "connecting",
      starting: true,
      version: target?.agent_version ?? null,
      lines: 3,
      restoreToken: 1,
      lastError: "Server error: Unknown error",
    }),
  },
  events: [
    { seq: 1, at: "2026-09-09T09:00:00.000Z", since: -400, level: "info", code: "app.foreground", message: "foreground", provider: null },
    { seq: 2, at: "2026-09-09T09:00:01.000Z", since: 0, level: "info", code: "session.start", message: "starting", provider: null, data: { version: target?.agent_version ?? null, takeover: false } },
    { seq: 3, at: "2026-09-09T09:00:01.200Z", since: 200, level: "info", code: "transport.mint", message: "minting a conversation token", provider: "elevenlabs", data: { route: "/api/v2/words-agent/token" } },
    // Gap: 4..8 evicted.
    { seq: 9, at: "2026-09-09T09:00:02.600Z", since: 1600, level: "error", code: "transport.error", message: "Server error: Unknown error", provider: "elevenlabs", data: { errorType: "quota_exceeded", code: 1008, debugMessage: "This request exceeds your quota limit." } },
    // A code this build does not know — the openness the registry promises.
    { seq: 10, at: "2026-09-09T09:00:02.700Z", since: 1700, level: "error", code: "transport.quantum_flux", message: "from a newer build", provider: "elevenlabs" },
  ],
  transcriptTail: [],
  capturedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
});

if (!report) {
  console.error("✗ sanitizeDebugReport refused the fixture — that is itself the bug.");
  process.exit(1);
}

const id = await insertDebugReport(ownerId, report, target?.lesson_id ?? null);
console.log(`✓ inserted ${id}`);

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

try {
  const list = await listDebugReports(ownerId, { kind: "error" });
  check("list finds it", list.some((r) => r.id === id), `${list.length} error report(s)`);

  const filtered = await listDebugReports(ownerId, { errorCode: "transport.error" });
  check("error_code filter works", filtered.some((r) => r.id === id));

  const facets = await debugReportFacets(ownerId);
  check("facets include the provider", facets.providers.includes("elevenlabs"), facets.providers.join(", "));
  check("facets include the error code", facets.errorCodes.includes("transport.error"));

  const full = await getDebugReport(ownerId, id);
  check("detail loads", full !== null);
  check("events survived the round trip", full?.events.length === 5, `${full?.events.length} events`);
  check("the seq gap is intact", full?.events[3]?.seq === 9, "4..8 evicted, as filed");
  check("the unknown code survived", full?.events[4]?.code === "transport.quantum_flux");
  check("captured_at is not created_at", full !== null && full.captured_at !== full.created_at);

  const changed = full?.state.live && full.state.atError
    ? (Object.keys(full.state.live) as (keyof typeof full.state.live)[]).filter(
        (k) => JSON.stringify(full.state.atError?.[k]) !== JSON.stringify(full.state.live?.[k]),
      )
    : [];
  check("the state diff has something to show", changed.length > 0, `${changed.length} fields: ${changed.join(", ")}`);

  if (target) {
    const session = await getSessionForConversation(ownerId, target.conversation_id);
    check("the transcript joins", session !== null, `${session?.transcript.length ?? 0} lines from lesson_sessions`);
  }

  const agent = resolveReportAgent(report.agentVersion);
  console.log(`  agent: ${agent ? `${agent.version} / ${agent.provider} / ${agent.agentId ?? "no object"}` : `${report.agentVersion} — not in the current registry`}`);
  // The real lookup, not a constructed string: a LangSmith run lives under three ids, none of them
  // derivable from a conversation id. This is the one link on the page that can come back empty.
  const traceUrl = target ? await langsmithTraceUrl(target.conversation_id) : null;
  console.log(
    `  langsmith: ${traceUrl ?? `not found — search for "${target ? langsmithTraceName(target.conversation_id) : "?"}"`}`,
  );
  console.log(`  console: ${target ? (providerConsoleUrl("elevenlabs", target.conversation_id)?.url ?? "none") : "n/a"}`);

  await setDebugReportTriage(ownerId, id, { status: "open", resolution: "verified" });
  const triaged = await getDebugReport(ownerId, id);
  check("triage writes", triaged?.status === "open" && triaged.resolution === "verified");

  // The list's one-click Resolve sends no resolution; it must not blank the one saved above.
  await setDebugReportTriage(ownerId, id, { status: RESOLVED_STATUS });
  const resolved = await getDebugReport(ownerId, id);
  check(
    "resolve keeps the resolution",
    resolved?.status === RESOLVED_STATUS && resolved.resolution === "verified",
  );

  // Ownership is in the query's own `where`, not in a check before it: a forged id must update
  // nothing rather than someone else's row.
  const stranger = await getDebugReport("auth0|not-this-owner", id);
  check("another owner cannot read it", stranger === null);
  const strangerDeleted = await deleteDebugReport("auth0|not-this-owner", id);
  check(
    "another owner cannot delete it",
    !strangerDeleted && (await getDebugReport(ownerId, id)) !== null,
  );
} finally {
  if (keep) {
    console.log(`\n→ kept. Open /ops/reports/${id}`);
  } else {
    // The page's own delete, so the cleanup is also the check that it works.
    const deleted = await deleteDebugReport(ownerId, id);
    check("the owner can delete it", deleted && (await getDebugReport(ownerId, id)) === null);
    console.log(`\n✓ deleted ${id}`);
  }
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures}`);
  process.exit(1);
}
console.log("\ndebug-report data layer: all checks passed");
