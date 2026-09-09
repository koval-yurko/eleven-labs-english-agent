import Link from "next/link";
import { notFound } from "next/navigation";

import type { DebugClientInfo } from "@tutor/shared/debug/report";

import { getOwnerId } from "../../../../lib/auth/session";
import {
  langsmithTraceName,
  langsmithTraceUrl,
  providerConsoleUrl,
  resolveReportAgent,
} from "../../../../lib/debug-report-links";
import { getDebugReport, getSessionForConversation } from "../../../../lib/debug-reports";
import { formatDateTime } from "../../../../lib/format-date";
import { triageReportAction } from "../actions";
import { StateDiff } from "./StateDiff";
import { Timeline } from "./Timeline";

export const dynamic = "force-dynamic";

/**
 * One report, in the order an investigation reads it.
 *
 * **The note is first**, quoted, where it cannot be missed: it is the only part of a report a
 * machine could not have produced, and it is routinely the fastest route to the cause (§1.5).
 *
 * Then the identity and the join keys — because the first question is always "which build, which
 * provider, which conversation" — then the state, then the story. The transcript comes from the
 * JOINED `lesson_sessions` row rather than from the report, which is what makes §6's decision pay
 * off: the report carries the conversation id and the page fetches the lines that are already
 * stored under it for this owner.
 *
 * See docs/2026-09-09-mobile-debug-reports-and-feedback.md §12.2, §12.3.
 */
export default async function OpsReportPage({ params }: { params: Promise<{ id: string }> }) {
  const ownerId = await getOwnerId();
  const { id } = await params;
  if (!ownerId) {
    return (
      <>
        <h1>Report</h1>
        <p className="muted">Sign in to read reports.</p>
      </>
    );
  }

  const report = await getDebugReport(ownerId, id);
  if (!report) notFound();

  const conversationId = report.conversation_id;
  // In parallel: both are independent lookups keyed on the same conversation id, and the LangSmith
  // one talks to a third party — serialising them would add its latency to the transcript's.
  const [session, langsmith] = await Promise.all([
    // The transcript, joined. Null when the session never connected — not an error but the very
    // case this table exists for, so it is said out loud rather than rendered as an empty list.
    conversationId ? getSessionForConversation(ownerId, conversationId) : null,
    conversationId ? langsmithTraceUrl(conversationId) : null,
  ]);
  const agent = resolveReportAgent(report.agent_version);
  const console_ = conversationId ? providerConsoleUrl(report.provider, conversationId) : null;
  const client = report.client as Partial<DebugClientInfo>;
  const spooledFor =
    new Date(report.created_at).getTime() - new Date(report.captured_at).getTime();

  return (
    <>
      <p className="muted" style={{ marginBottom: 0 }}>
        <Link href="/ops/reports">← All reports</Link>
      </p>
      <h1>
        {report.error_code ? <span className="error">{report.error_code}</span> : report.kind}
      </h1>

      {report.note ? (
        <blockquote
          style={{
            margin: "0 0 1rem",
            padding: "0.75rem 1rem",
            borderLeft: "3px solid var(--accent)",
            background: "var(--panel)",
          }}
        >
          {report.note}
        </blockquote>
      ) : (
        <p className="muted">No note — filed without a description.</p>
      )}

      {report.error_message ? <p className="error">{report.error_message}</p> : null}

      <section className="panel">
        <h2>Identity</h2>
        <Field label="Captured">{formatDateTime(report.captured_at)}</Field>
        <Field label="Arrived">
          {formatDateTime(report.created_at)}
          {/* Only interesting when it differs. It says the report waited on the device and a later
              retry sent it — NOT why the first attempt failed. Naming a cause here would be a guess,
              and on a report whose own timeline may contain a successful request, a contradictory
              one. */}
          {spooledFor > 60_000 ? (
            <span className="warn"> · spooled {formatGap(spooledFor)} before it sent</span>
          ) : null}
        </Field>
        <Field label="Build">
          {client.appVersion ?? "?"} ({client.buildNumber || "?"}) · {client.variant ?? "?"} ·{" "}
          {client.platform ?? "?"} {client.osVersion ?? ""} · {client.deviceModel ?? "?"}
        </Field>
        <Field label="API">{client.apiBaseUrl ?? "—"}</Field>
        <Field label="Kind">{report.kind}</Field>
      </section>

      <section className="panel">
        <h2>Join keys</h2>
        <Field label="Lesson">
          {report.lesson_id ? (
            <Link href={`/lessons/${report.lesson_id}`}>{report.lesson_id}</Link>
          ) : (
            /* Nulled by the route when the lesson was unknown — deliberately NOT a 404 there, since
               a report whose lesson id is wrong is evidence about a wrong lesson id (§10). */
            <span className="muted">none — unknown to the server, or the lesson was deleted</span>
          )}
        </Field>
        <Field label="Conversation">
          {conversationId ? <code>{conversationId}</code> : <span className="muted">none — this session never got a row key</span>}
        </Field>
        <Field label="Agent">
          {agent ? (
            <>
              {agent.version} on {agent.provider}
              {agent.agentId ? (
                <>
                  {" "}
                  · <code>{agent.agentId}</code>
                </>
              ) : (
                <span className="muted"> · no provisioned agent object (config is per request)</span>
              )}
            </>
          ) : report.agent_version ? (
            /* A version this deployment no longer offers. Reported, not hidden: a report from a
               build running a retired version is itself the finding. */
            <span className="warn">
              {report.agent_version} — not in the current registry (retired, or never known here)
            </span>
          ) : (
            <span className="muted">none</span>
          )}
        </Field>
        {langsmith || console_ ? (
          <p className="row" style={{ marginTop: "0.75rem" }}>
            {langsmith ? (
              <a href={langsmith} target="_blank" rel="noreferrer">
                LangSmith trace
              </a>
            ) : null}
            {console_ ? (
              <a href={console_.url} target="_blank" rel="noreferrer">
                {console_.label}
              </a>
            ) : null}
          </p>
        ) : null}
        {/* The lookup found nothing, timed out, or there is no key — so the manual version of the
            same search. A lesson that never connected has no trace at all, which is not a failure
            but the most likely reading of an empty result here. */}
        {conversationId && !langsmith ? (
          <p className="muted" style={{ marginTop: "0.75rem" }}>
            No LangSmith trace found. Search the project for{" "}
            <code>{langsmithTraceName(conversationId)}</code>.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>State</h2>
        <StateDiff
          live={report.state?.live}
          atError={report.state?.atError}
          events={report.events ?? []}
        />
      </section>

      <section className="panel">
        <h2>Timeline</h2>
        <Timeline events={report.events ?? []} />
      </section>

      <section className="panel">
        <h2>Transcript</h2>
        {session ? (
          <>
            <p className="muted">
              From the stored conversation
              {session.duration_secs !== null ? ` · ${session.duration_secs}s` : ""} ·{" "}
              {session.transcript.length} lines
            </p>
            {session.summary ? <p>{session.summary}</p> : null}
            {session.transcript.map((line, i) => (
              <p key={i} style={{ margin: "0.25rem 0" }}>
                <span className="dot">{line.role === "agent" ? "Teacher" : "You"}:</span>{" "}
                {line.text}
              </p>
            ))}
          </>
        ) : report.transcript_tail?.length > 0 ? (
          <>
            {/* The opt-in tail. It only exists when the toggle was on, and the one case it helps is
                a report about what the tutor SAID, filed while the conversation was still live and
                unsaved — i.e. exactly when there is no stored row to join to. */}
            <p className="muted">
              No stored conversation. These {report.transcript_tail.length} lines travelled in the
              report itself.
            </p>
            {report.transcript_tail.map((line, i) => (
              <p key={i} style={{ margin: "0.25rem 0" }}>
                <span className="dot">{line.role === "agent" ? "Teacher" : "You"}:</span>{" "}
                {line.text}
              </p>
            ))}
          </>
        ) : (
          <p className="muted">
            No transcript. A session that never connected has none — which is the case this report
            most likely describes.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Triage</h2>
        <form action={triageReportAction}>
          <input type="hidden" name="id" value={report.id} />
          <div className="filter-row">
            <span className="filter-label">Status</span>
            {/* A text input, not a select. `status` is unconstrained text in the schema for the
                same reason (§9): the set of useful states is not knowable before the page has been
                used, and a state that needs a code change to invent is a state nobody invents. */}
            <input
              name="status"
              defaultValue={report.status}
              style={{ width: "12ch" }}
              aria-label="Status"
            />
          </div>
          <textarea
            name="resolution"
            defaultValue={report.resolution ?? ""}
            placeholder="What this turned out to be, and what fixed it."
            rows={3}
            style={{ marginTop: "0.5rem" }}
          />
          <button type="submit" className="btn btn--secondary" style={{ marginTop: "0.5rem" }}>
            Save
          </button>
        </form>
      </section>

      <details className="panel">
        <summary style={{ cursor: "pointer" }}>Raw row</summary>
        <pre style={{ fontSize: "0.8rem" }}>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p style={{ margin: "0.25rem 0" }}>
      <span className="muted" style={{ display: "inline-block", minWidth: "10ch" }}>
        {label}
      </span>{" "}
      {children}
    </p>
  );
}

function formatGap(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 90) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}
