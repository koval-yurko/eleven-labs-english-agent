// Print one debug report as a self-contained Markdown document — the handoff to Claude.
//
// ## Why a repo script and not an MCP tool
//
// `/api/mcp` is already deployed, already authenticated and already registered with two voice
// platforms, which is exactly what makes it the wrong place. Its own docblock draws the line:
//
//   > **The first read tool makes this an exfiltration channel.** […] **Under one shared secret, a
//   > new permission is a new TOKEN — or it does not exist.**
//
// A debug report is strictly worse to expose than the word collection — device identity, a state
// machine dump, API paths, optionally transcript text — so `get_debug_report` on `tutor-collection`
// would retroactively grant every existing `MCP_TOKEN` holder, including two third parties, read
// access to it. A script needs no new auth surface, no new network exposure and no new secret: it
// reads Supabase with the service-role key that is already in `.env`, and Claude Code can run it
// directly in this repo. See docs/2026-09-09-mobile-debug-reports-and-feedback.md §13.
//
// ## Read-only, deliberately
//
// There is no `--resolve`. Excluded so the script is safe to run without thinking about what it
// might change — triage is the operator page's job (§16 Q4).
//
// Usage:
//   pnpm report <id>              one report as Markdown (an 8-char prefix is enough)
//   pnpm report --list            the ten newest, so an id is never needed from memory
//   pnpm report <id> --json       the raw row
//   pnpm report --since 7d        what has been breaking, grouped by error code
//   pnpm report ... --owner=<sub> narrow to one Auth0 sub
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env.local", ".env"]) dotenv.config({ path: join(root, file) });

// Imported AFTER dotenv: `getServiceSupabase` reads its env at first call, but the LangSmith client
// and the agent registry both read theirs at module scope.
const { getServiceSupabase, hasSupabaseEnv } = await import("../src/lib/supabase/server");
const { changedFields, diagnoseSnapshot, orderedFields } = await import(
  "../src/lib/debug-report-diagnose"
);
const { langsmithTraceName, langsmithTraceUrl, providerConsoleUrl, resolveReportAgent } =
  await import("../src/lib/debug-report-links");
const { getSessionForConversation } = await import("../src/lib/debug-reports");

type SessionSnapshot = import("@tutor/shared/debug/report").SessionSnapshot;
type DebugEvent = import("@tutor/shared/debug/report").DebugEvent;

if (!hasSupabaseEnv()) {
  console.error("✗ Supabase env not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((a) => !a.startsWith("--"));

const owner = value("owner");

/**
 * The columns every mode reads. `events`, `state` and the two transcript columns are fat, so
 * `--list` and `--since` deliberately ask for a narrower set below.
 */
const FULL =
  "id, owner_id, created_at, captured_at, kind, note, lesson_id, conversation_id, provider, agent_version, error_code, error_message, client, state, events, transcript_tail, status, resolution";
const SLIM =
  "id, created_at, captured_at, kind, note, provider, agent_version, error_code, error_message, status";

interface Row {
  id: string;
  owner_id: string;
  created_at: string;
  captured_at: string;
  kind: string;
  note: string;
  lesson_id: string | null;
  conversation_id: string | null;
  provider: string | null;
  agent_version: string | null;
  error_code: string | null;
  error_message: string | null;
  client: Record<string, unknown>;
  state: { live?: SessionSnapshot; atError?: SessionSnapshot | null };
  events: DebugEvent[];
  transcript_tail: { role: string; text: string }[];
  status: string;
  resolution: string | null;
}

/**
 * The owner filter is applied INLINE at each of the three call sites, with the
 * `let query = …; if (…) query = query.eq(…)` shape `lib/debug-reports.ts` already uses.
 *
 * A generic helper reads better and does not compile: PostgREST's builder types are parameterised
 * over the selected columns, and a `<T extends { eq(…): T }>` wrapper sends `tsc` into "type
 * instantiation is excessively deep". Three repeated lines beat a helper that needs a cast.
 *
 * **There is no default owner and no session.** This runs with the service-role key on a
 * developer's machine, exactly like `enrich:words` and `level:items` — the same posture, and the
 * reason `--owner` exists at all.
 */

// ── modes ────────────────────────────────────────────────────────────────────────────────────

if (flag("list")) {
  let listing = getServiceSupabase().from("debug_reports").select(SLIM);
  if (owner) listing = listing.eq("owner_id", owner);
  const { data, error } = await listing
    .order("created_at", { ascending: false })
    .limit(Number(value("limit") ?? 10));
  if (error) throw new Error(error.message);
  const rows = (data as unknown as Row[] | null) ?? [];
  if (rows.length === 0) {
    console.log("No reports.");
  } else {
    console.log("| id | filed | kind | status | provider / version | error |");
    console.log("|---|---|---|---|---|---|");
    for (const r of rows) {
      console.log(
        `| \`${r.id.slice(0, 8)}\` | ${iso(r.captured_at)} | ${r.kind} | ${r.status} | ${r.provider ?? "—"} / ${r.agent_version ?? "—"} | ${r.error_code ?? "—"} |`,
      );
    }
    console.log(`\nRun \`pnpm report <id>\` for any of these.`);
  }
  process.exit(0);
}

if (value("since")) {
  const since = parseSince(value("since") as string);
  if (since === null) {
    console.error("✗ --since takes a duration like 24h, 7d or 30d.");
    process.exit(1);
  }
  let recent = getServiceSupabase().from("debug_reports").select(SLIM);
  if (owner) recent = recent.eq("owner_id", owner);
  const { data, error } = await recent
    .gte("created_at", new Date(Date.now() - since).toISOString())
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as Row[] | null) ?? [];

  console.log(`# What has been breaking — last ${value("since")}\n`);
  console.log(`${rows.length} report${rows.length === 1 ? "" : "s"}.\n`);
  if (rows.length > 0) {
    // Grouped by the denormalized column, which is the whole reason it is a column (§9): "how many
    // reports this week carry `transport.error` with code 1008" is the first question, every time.
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = r.error_code ?? `(no error — ${r.kind})`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    console.log("| n | error | providers | most recent |");
    console.log("|---|---|---|---|");
    for (const [key, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      const providers = [...new Set(group.map((r) => r.provider ?? "—"))].join(", ");
      const newest = group[0];
      console.log(
        `| ${group.length} | \`${key}\` | ${providers} | \`${newest?.id.slice(0, 8) ?? "?"}\` ${newest ? iso(newest.captured_at) : ""} |`,
      );
    }
  }
  process.exit(0);
}

const wanted = positional[0];
if (!wanted) {
  console.error("Usage: pnpm report <id> | --list | --since 7d   (add --json for the raw row)");
  process.exit(1);
}

/**
 * Resolve an id PREFIX, because that is what the modal hands the learner.
 *
 * The Send tab shows `report 4f2a1c9e` — eight characters, chosen so it can be read off a phone
 * screen and typed. Postgres has no prefix operator for `uuid` that PostgREST exposes, so the
 * newest rows are fetched and matched here. Fine at this volume, and it fails loudly rather than
 * guessing when a prefix is ambiguous.
 */
let ids = getServiceSupabase().from("debug_reports").select("id");
if (owner) ids = ids.eq("owner_id", owner);
const { data: candidates, error: listError } = await ids
  .order("created_at", { ascending: false })
  .limit(1000);
if (listError) throw new Error(listError.message);
const matches = ((candidates as { id: string }[] | null) ?? []).filter((r) =>
  r.id.startsWith(wanted.toLowerCase()),
);
if (matches.length === 0) {
  console.error(`✗ No report matching "${wanted}". Try \`pnpm report --list\`.`);
  process.exit(1);
}
if (matches.length > 1) {
  console.error(`✗ "${wanted}" matches ${matches.length} reports. Use more characters:`);
  for (const m of matches.slice(0, 10)) console.error(`   ${m.id}`);
  process.exit(1);
}

const id = matches[0]?.id as string;
const { data, error } = await getServiceSupabase()
  .from("debug_reports")
  .select(FULL)
  .eq("id", id)
  .single();
if (error) throw new Error(error.message);
const report = data as unknown as Row;

if (flag("json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// ── the document ─────────────────────────────────────────────────────────────────────────────
//
// Written FOR A MODEL TO READ, which is a different brief from the operator page's:
//
//  - stable section headers, so a reader can be told "look under ## State" and find it;
//  - the timeline as a table with one event per row, rather than nested prose;
//  - relative timestamps, because the absolute ones are only useful against an external log;
//  - and the state diff PRE-COMPUTED rather than left as two JSON blobs to be compared by eye.
//
// The last one is the whole point. Handing over `live` and `atError` and expecting them to be
// diffed is handing over the work; naming the nine fields that changed is handing over the answer.

const client = report.client as Record<string, string | boolean | undefined>;
const agent = resolveReportAgent(report.agent_version);
const traceUrl = report.conversation_id ? await langsmithTraceUrl(report.conversation_id) : null;
const console_ = report.conversation_id
  ? providerConsoleUrl(report.provider, report.conversation_id)
  : null;
const session = report.conversation_id
  ? await getSessionForConversation(report.owner_id, report.conversation_id)
  : null;

/**
 * The registry's provider for that version, and **why it is a plain row rather than a warning.**
 *
 * Two readers stopped on `Provider: elevenlabs` next to `Agent: words-2.0 on openai` and had to
 * reason past it, so the first repair was to print it only on a real disagreement — with a `⚠` and
 * a bold label. That made it worse, and the next reader said so: it had *"warning styling, a bold
 * header row, and top-of-document placement — above the actual error"*, on a report where the
 * mismatch explained nothing.
 *
 * The lesson is about RANK, not presence. A registry re-point is real and occasionally relevant,
 * but it is CONTEXT — and context printed louder than the failure competes with it. So it is a
 * quiet clause on the `Provider` row, worded as a fact.
 */
const registryProvider =
  agent && report.provider && agent.provider !== report.provider ? agent.provider : null;

const out: string[] = [];
const say = (line = "") => out.push(line);

say(`# Debug report \`${report.id.slice(0, 8)}\``);
say();
say(`Full id: \`${report.id}\``);
say();

// ── header ───────────────────────────────────────────────────────────────────────────────────
const spooled = new Date(report.created_at).getTime() - new Date(report.captured_at).getTime();
say(`| | |`);
say(`|---|---|`);
say(`| **Kind** | ${report.kind} |`);
say(`| **Status** | ${report.status}${report.resolution ? ` — ${report.resolution}` : ""} |`);
say(`| **Captured** | ${iso(report.captured_at)} |`);
// The GAP, not a reason for it. "The phone could not reach the server for that long" is an
// inference, and on a report whose own timeline contains a successful 200 it is an inference that
// reads as a contradiction. A spooled report means the send failed and was retried later; why it
// failed is what the rest of the document is for.
say(
  `| **Arrived** | ${iso(report.created_at)}${spooled > 60_000 ? ` — **${gap(spooled)} after it was captured**, so it was spooled on the device and sent by a later retry` : ""} |`,
);
say(
  `| **Build** | ${client.appVersion ?? "?"} (${client.buildNumber || "?"}) · ${client.variant ?? "?"} · ${client.platform ?? "?"} ${client.osVersion ?? ""} · ${client.deviceModel ?? "?"} |`,
);
say(`| **API** | ${client.apiBaseUrl ?? "—"} |`);
say(`| **Owner** | \`${report.owner_id}\` |`);
say(
  `| **Provider** | ${report.provider ?? "—"} — the stack the phone actually ran the session on${
    registryProvider
      ? `; \`${report.agent_version}\` is registered to ${registryProvider} today, so the version was re-pointed after this build shipped`
      : ""
  } |`,
);
say(
  `| **Agent** | ${
    agent
      ? `${agent.version}${agent.agentId ? ` · \`${agent.agentId}\`` : " · no provisioned agent object (this provider builds its session per request)"}`
      : report.agent_version
        ? `\`${report.agent_version}\` — **not in the current registry** (retired, or from a build this deployment does not know)`
        : "—"
  } |`,
);
/**
 * What the server actually knows about the lesson the CONVERSATION belonged to.
 *
 * The route nulls `lesson_id` when it cannot match one, so the column alone can only ever say
 * "unknown to the server, or deleted" — two very different bugs with completely different fixes, and
 * both readers of the lost-transcript fixture named that ambiguity as the one thing they would have
 * to leave the document to resolve.
 *
 * They should not have to. This script holds the service-role key; the lookup is one query and it
 * turns the guess into a fact: no such row at all, a row that was soft-deleted (0008) and when, or a
 * row that exists and belongs to someone else. The id comes from the snapshot rather than the
 * column, because the interesting case is precisely the one where the column is null.
 */
const conversationLesson =
  report.state?.atError?.conversationLesson ?? report.state?.live?.conversationLesson ?? null;
const lessonFact = await describeLesson(report.lesson_id ?? conversationLesson, report.owner_id);
say(`| **Lesson** | ${lessonFact} |`);
say(
  `| **Conversation** | ${report.conversation_id ? `\`${report.conversation_id}\`` : "none — this session never got a row key"} |`,
);
if (traceUrl) say(`| **LangSmith** | ${traceUrl} |`);
else if (report.conversation_id) {
  say(`| **LangSmith** | no trace found — search the project for \`${langsmithTraceName(report.conversation_id)}\` |`);
}
if (console_) say(`| **${console_.label}** | ${console_.url} |`);
say();

// ── the note ─────────────────────────────────────────────────────────────────────────────────
say(`## What the learner said`);
say();
// The one field a machine could not have produced, and routinely the fastest route to the cause.
say(report.note ? report.note.split("\n").map((l) => `> ${l}`).join("\n") : "_Nothing — filed without a description._");
say();

// ── the error ────────────────────────────────────────────────────────────────────────────────
say(`## The error`);
say();
if (report.error_code) {
  say(`\`${report.error_code}\` — ${report.error_message ?? "(no message)"}`);
  /**
   * **The structured detail belongs HERE, not only in the timeline's last column.**
   *
   * `error_message` is the raw string the SDK handed over, and on the failure this whole feature
   * was built for that string is `"Server error: Unknown error"` — it names nothing. Everything
   * that does name the cause (`errorType`, `code`, `debugMessage`) arrives in the event's `data`.
   *
   * Printing only the message here reproduced §1.1's exact failure one layer up: the diagnostics
   * were present, and buried. A reader given this document found the cause in the last cell of a
   * wide table forty lines down and said so — so the headline now carries it.
   */
  const raised = [...(report.events ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .filter((e) => e.level === "error" && e.code === report.error_code)
    .pop();
  if (raised?.data && Object.keys(raised.data).length > 0) {
    say();
    say(`The provider's own fields, off the wire:`);
    say();
    for (const [k, v] of Object.entries(raised.data)) say(`- \`${k}\`: ${String(v)}`);
  }
} else {
  say("_No error was recorded. This is a report about behaviour rather than a failure._");
}
say();

// ── the state ────────────────────────────────────────────────────────────────────────────────
const live = report.state?.live;
const atError = report.state?.atError ?? null;
const authoritative = atError ?? live;

say(`## State`);
say();
if (!authoritative) {
  say("_No snapshot — the report was filed with no session mounted._");
  say();
} else {
  const problems = diagnoseSnapshot(authoritative, report.events ?? []);
  say(`### Worth checking in the state`);
  say();
  if (problems.length === 0) {
    // NOT "nothing is wrong". A session can be completely broken with a perfectly self-consistent
    // snapshot — the quota outage is exactly that — and a reader who skims this line as reassurance
    // has been sent the wrong way by the section meant to help them.
    say(
      "No two fields in the snapshot contradict each other. **This is not evidence that nothing is wrong** — a session that was refused before it started leaves a perfectly consistent state. The cause, if there is one, is in the timeline.",
    );
  } else {
    // Heuristics over ONE MOMENT with no event ordering in it — see `diagnoseSnapshot`. Said out
    // loud, because this is the section a reader trusts on a skim.
    say(
      "These are heuristics over a single snapshot, which carries no event ordering. **Confirm each against the timeline before believing it.**",
    );
    say();
    for (const p of problems) say(`- ${p}`);
  }
  say();

  const changed = changedFields(live, atError);
  if (atError) {
    say(`### Changed between the error and filing`);
    say();
    if (changed.length === 0) {
      say("_Nothing._ The state below is the state that failed.");
    } else {
      // Named as expected teardown, because that is what it usually is. A reader saw
      // `owns ✓→✗`, `lines 24→0`, `kickedOff ✓→✗` and read state corruption; it was a session
      // ending normally. The diff is worth printing — a field that DIDN'T clear is the finding —
      // but not worth printing as if every row were a symptom.
      say(
        `The bus froze a copy of the state at the first error, because by the time a report is filed the session has usually moved on. ${changed.length} field${changed.length === 1 ? "" : "s"} differ — for a session that has since ended, most of these are ordinary teardown (\`owns\`, \`lines\`, \`conversationId\` clearing). Look for the ones that are NOT:`,
      );
      say();
      say(`| field | at the error | when filed |`);
      say(`|---|---|---|`);
      for (const k of changed) say(`| \`${k}\` | ${cell(atError[k])} | ${cell(live?.[k])} |`);
    }
    say();
  }

  say(atError ? `### Full state at the error` : `### Full state`);
  say();
  say(`| field | value |`);
  say(`|---|---|`);
  // Reading order, not `Object.keys` — see `orderedFields`. A snapshot out of `jsonb` comes back
  // sorted by key length, which puts `focusedLesson` twenty rows from `conversationLesson`.
  for (const k of orderedFields(authoritative)) {
    say(`| \`${k}\` | ${cell(authoritative[k])} |`);
  }
  say();
}

// ── the timeline ─────────────────────────────────────────────────────────────────────────────
say(`## Timeline`);
say();
const events = [...(report.events ?? [])].sort((a, b) => a.seq - b.seq);
if (events.length === 0) {
  say("_No events._");
} else {
  const base = events[0]?.since ?? 0;
  say(`\`+t\` is relative to the first event. ${events.length} events.`);
  say();
  say(`| +t | level | code | provider | message | data |`);
  say(`|---|---|---|---|---|---|`);
  let previous: DebugEvent | undefined;
  for (const e of events) {
    // A `seq` gap means the ring evicted events. Stated as a row of its own, because a truncated
    // log that looks complete is worse than one that says so.
    if (previous && e.seq - previous.seq > 1) {
      say(`| | | **— ${e.seq - previous.seq - 1} events dropped —** | | | |`);
    }
    const data = e.data
      ? Object.entries(e.data)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(" ")
      : "";
    say(
      `| ${((e.since - base) / 1000).toFixed(1)}s | ${e.level} | \`${e.code}\` | ${e.provider ?? ""} | ${md(e.message)} | ${md(data)} |`,
    );
    previous = e;
  }
}
say();

// ── the transcript ───────────────────────────────────────────────────────────────────────────
say(`## Transcript`);
say();
if (session) {
  // JOINED, not carried. The report stores the conversation id and the lines live in
  // `lesson_sessions` under it for the same owner — which is what keeps a report ~60 KB (§6).
  say(
    `From the stored conversation${session.duration_secs !== null ? ` (${session.duration_secs}s)` : ""} — ${session.transcript.length} lines.`,
  );
  say();
  if (session.summary) {
    say(`> ${session.summary}`);
    say();
  }
  for (const line of session.transcript) {
    say(`**${line.role === "agent" ? "Teacher" : "Learner"}:** ${line.text}`);
  }
} else if (report.transcript_tail?.length > 0) {
  say(
    `No stored conversation. These ${report.transcript_tail.length} lines travelled in the report itself (the opt-in tail).`,
  );
  say();
  for (const line of report.transcript_tail) {
    say(`**${line.role === "agent" ? "Teacher" : "Learner"}:** ${line.text}`);
  }
} else {
  // The FACT, and the reading offered as one possibility rather than asserted. Canned text naming
  // a cause is worse than an empty section: a session that connected, collected turns and then
  // failed to SAVE them lands here too, and being told it never connected sends the reader the
  // wrong way. The timeline distinguishes the two; this line should not pretend to.
  say(
    `_None stored under \`${report.conversation_id ?? "(no conversation id)"}\`._ Either the session never connected — a lesson that fails to start has no transcript at all — or it connected and the save did not land. The timeline says which: look for \`session.end\` and \`persist.*\`.`,
  );
}
say();

say(`---`);
say();
say(
  `Raw row: \`pnpm report ${report.id.slice(0, 8)} --json\` · Operator page: \`/ops/reports/${report.id}\``,
);

console.log(out.join("\n"));

// ── formatting ───────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a lesson id to what the database actually holds — the answer the report cannot carry.
 *
 * Four outcomes, and they are four different bugs:
 *   - no id at all — nothing to look up;
 *   - **no such row** — the id never existed server-side, which points at an unsynced create rather
 *     than a deletion;
 *   - **soft-deleted** (0008) — the row is there with a `deleted_at`, so it WAS deleted, and when;
 *   - **another owner's** — the 404 was an ownership refusal, not a missing row.
 *
 * Owner-scoping is deliberately NOT applied to the query: the whole point is to tell "missing" apart
 * from "not yours", and a scoped lookup collapses both into one empty result — the same collapse
 * that makes the report's own column ambiguous.
 */
async function describeLesson(lessonId: string | null, ownerId: string): Promise<string> {
  if (!lessonId) return "none — the report carries no lesson id";
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .select("id, owner_id, title, created_at, deleted_at")
    .eq("id", lessonId)
    .maybeSingle();
  if (error) return `\`${lessonId}\` — lookup failed (${error.message})`;
  const row = data as
    | { owner_id: string; title: string; created_at: string; deleted_at: string | null }
    | null;
  if (!row) {
    return `\`${lessonId}\` — **no such row in \`lessons\`.** The id never reached the server, so this is an unsynced create rather than a deletion.`;
  }
  if (row.owner_id !== ownerId) {
    return `\`${lessonId}\` — exists ("${row.title}") but belongs to a DIFFERENT owner. Any 404 was an ownership refusal, not a missing row.`;
  }
  if (row.deleted_at) {
    return `\`${lessonId}\` — "${row.title}", **soft-deleted at ${iso(row.deleted_at)}.** A write attempted after that is refused by design.`;
  }
  return `\`${lessonId}\` — "${row.title}", alive, created ${iso(row.created_at)}`;
}

/** Pinned to UTC for the same reason `lib/format-date.ts` is: the output must not depend on where it ran. */
function iso(value: string): string {
  return new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function gap(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 90) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** A snapshot value as one table cell. Booleans as ticks, because a column of them is scannable. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (typeof v === "object") return `\`${JSON.stringify(v)}\``;
  return typeof v === "string" && v.length > 0 ? `\`${v}\`` : String(v);
}

/** A pipe inside a cell ends the cell. Escaped, and newlines flattened, so the table survives. */
function md(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function parseSince(input: string): number | null {
  const match = /^(\d+)([hd])$/.exec(input.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return match[2] === "h" ? n * 3600_000 : n * 24 * 3600_000;
}
