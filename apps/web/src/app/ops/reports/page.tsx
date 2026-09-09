import Link from "next/link";

import type { DebugReportKind } from "@tutor/shared/debug/report";

import { getOwnerId } from "../../../lib/auth/session";
import {
  debugReportFacets,
  listDebugReports,
  type DebugReportFilter,
  type DebugReportSummary,
} from "../../../lib/debug-reports";
import { formatDateTime } from "../../../lib/format-date";

// Owner-scoped and changes between visits. Cookie auth, not Bearer: this one is a browser page.
export const dynamic = "force-dynamic";

const KINDS: DebugReportKind[] = ["error", "feedback", "manual"];

/** The date ranges worth having, as the shortest thing that can be a query parameter. */
const RANGES: { key: string; label: string; hours: number | null }[] = [
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7 days", hours: 24 * 7 },
  { key: "30d", label: "30 days", hours: 24 * 30 },
  { key: "all", label: "All", hours: null },
];

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length > 0 ? first : undefined;
}

/**
 * `/ops/reports` — every report this owner has filed, newest first.
 *
 * ## Why the list is a table and not cards
 *
 * **Repetition is the signal.** Two identical rows at the top — same `error_code`, same provider,
 * minutes apart — is the difference between "a thing that happened" and "a thing that is
 * happening", and that is only visible when the rows line up. It is also the entire reason
 * `error_code` is a column on the table rather than a field inside `events` (§9): a `jsonb` scan
 * per row for a list view is a page that gets slow at exactly the moment it starts being useful.
 *
 * ## Why the filters are links
 *
 * No client component, no state, no `useSearchParams`. Every filter is a link that reloads the
 * server component with a different query string — which means the URL is the whole of the view,
 * and a filtered list can be pasted into a message.
 *
 * See docs/2026-09-09-mobile-debug-reports-and-feedback.md §12.2.
 */
export default async function OpsReportsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const ownerId = await getOwnerId();
  if (!ownerId) {
    return (
      <>
        <h1>Reports</h1>
        <p className="muted">Sign in to read reports.</p>
      </>
    );
  }

  const params = await searchParams;
  const rangeKey = one(params, "range") ?? "7d";
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[1];
  const filter: DebugReportFilter = {
    kind: KINDS.find((k) => k === one(params, "kind")),
    provider: one(params, "provider"),
    errorCode: one(params, "code"),
    status: one(params, "status"),
    ...(range?.hours ? { since: new Date(Date.now() - range.hours * 3600_000).toISOString() } : {}),
  };

  const [reports, facets] = await Promise.all([
    listDebugReports(ownerId, filter),
    debugReportFacets(ownerId),
  ]);

  /** Rebuild the query string with one key changed — an absent value clears that filter. */
  const href = (key: string, value: string | undefined): string => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      const first = Array.isArray(v) ? v[0] : v;
      if (first) next.set(k, first);
    }
    if (value === undefined) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    return qs ? `/ops/reports?${qs}` : "/ops/reports";
  };

  const chip = (key: string, value: string | undefined, label: string) => (
    <Link
      key={`${key}:${value ?? "any"}`}
      href={href(key, value)}
      className="chip"
      data-pressed={one(params, key) === value ? "" : undefined}
      style={{ textDecoration: "none" }}
    >
      {label}
    </Link>
  );

  return (
    <>
      <h1>Reports</h1>
      <p className="muted">
        Filed from the phone. {reports.length} shown
        {range?.hours ? ` from the last ${range.label.toLowerCase()}` : ""}.
      </p>

      <section className="panel">
        <Filters label="When">
          {RANGES.map((r) => chip("range", r.key, r.label))}
        </Filters>
        <Filters label="Kind">
          {chip("kind", undefined, "Any")}
          {KINDS.map((k) => chip("kind", k, k))}
        </Filters>
        {facets.providers.length > 0 ? (
          <Filters label="Provider">
            {chip("provider", undefined, "Any")}
            {facets.providers.map((p) => chip("provider", p, p))}
          </Filters>
        ) : null}
        {facets.statuses.length > 1 ? (
          <Filters label="Status">
            {chip("status", undefined, "Any")}
            {facets.statuses.map((s) => chip("status", s, s))}
          </Filters>
        ) : null}
        {facets.errorCodes.length > 0 ? (
          <Filters label="Error">
            {chip("code", undefined, "Any")}
            {facets.errorCodes.map((c) => chip("code", c, c))}
          </Filters>
        ) : null}
      </section>

      <section className="panel">
        {reports.length === 0 ? (
          <p className="muted">Nothing matches. Widen the range, or clear a filter.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
              <thead>
                <tr>
                  {["Status", "When", "Kind", "Provider / version", "Error", "Note"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "0.4rem 0.6rem 0.4rem 0",
                        borderBottom: "1px solid var(--border)",
                        color: "var(--muted)",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <Row key={r.id} report={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Filters({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="filter-row">
      <span className="filter-label">{label}</span>
      {children}
    </div>
  );
}

function Row({ report }: { report: DebugReportSummary }) {
  const cell = { padding: "0.5rem 0.6rem 0.5rem 0", borderBottom: "1px solid var(--border)" };
  return (
    <tr>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        <span className={report.status === "new" ? "warn" : "muted"}>{report.status}</span>
      </td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        <Link href={`/ops/reports/${report.id}`}>{formatDateTime(report.captured_at)}</Link>
        {/* Only when they disagree — which means the report SPOOLED, and the gap is how long the
            phone could not reach the server. Silent when they match, so the column stays readable. */}
        {arrivedLate(report) ? (
          <span className="muted"> · arrived {formatDateTime(report.created_at)}</span>
        ) : null}
      </td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{report.kind}</td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        {report.provider ?? "—"}
        {report.agent_version ? <span className="muted"> / {report.agent_version}</span> : null}
      </td>
      <td style={cell}>
        {report.error_code ? (
          <span className="error">{report.error_code}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td style={{ ...cell, maxWidth: "22ch" }}>
        <span className="muted">{report.note.slice(0, 60) || "—"}</span>
      </td>
    </tr>
  );
}

/** More than a minute between capture and arrival: the report waited in the spool. */
function arrivedLate(report: DebugReportSummary): boolean {
  return (
    new Date(report.created_at).getTime() - new Date(report.captured_at).getTime() > 60_000
  );
}
