import type { DebugEvent, SessionSnapshot } from "@tutor/shared/debug/report";

import {
  changedFields,
  diagnoseSnapshot,
  orderedFields,
} from "../../../../lib/debug-report-diagnose";

/**
 * The session state machine, with **the fields that disagree pulled to the front**.
 *
 * Two different disagreements are worth seeing, and this component renders both:
 *
 * 1. **`live` vs `atError`.** A learner hits an error at 14:02 and files at 14:07; by then `start`
 *    has run, `setError(null)` has fired, and the refs describe a different conversation. The bus
 *    freezes a copy at the first error for exactly this reason (§5.3), and the diff between the two
 *    is frequently the entire investigation.
 * 2. **Fields that disagree WITH EACH OTHER inside one snapshot.** `focusedLesson ≠
 *    conversationLesson`, `conversationId ≠ savedFor`, `owns ✗ while status connected` — each is a
 *    hazard `apps/mobile/src/lib/tutor-session.tsx` documents having been designed against, and
 *    none of them is visible from any screen. They are called out rather than left to the eye.
 *
 * A snapshot printed as two JSON blobs to be compared by hand is the thing this page exists instead
 * of, so the comparison is pre-computed.
 */
export function StateDiff({
  live,
  atError,
  events,
}: {
  live: SessionSnapshot | undefined;
  atError: SessionSnapshot | null | undefined;
  /** The ring, so a heuristic the timeline settles can settle rather than hedge. */
  events: DebugEvent[];
}) {
  if (!live) return <p className="muted">No snapshot — the report was filed with no session mounted.</p>;

  // Both rules live in `lib/debug-report-diagnose.ts`, shared with `pnpm report` — a page and a
  // terminal that disagreed about the same row would be a bug with nowhere to look. The ring goes
  // in for the same reason it does there: a rule that can check the ordering should not ask the
  // reader to.
  const changed = changedFields(live, atError);
  const suspicious = diagnoseSnapshot(atError ?? live, events);

  return (
    <>
      {suspicious.length > 0 ? (
        <ul style={{ margin: "0 0 1rem", paddingLeft: "1.1rem" }}>
          {suspicious.map((s) => (
            <li key={s} className="error">
              {s}
            </li>
          ))}
        </ul>
      ) : null}

      {atError && changed.length > 0 ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {changed.length} field{changed.length === 1 ? "" : "s"} changed between the error and
            the moment this was filed.
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead>
              <tr>
                {["", "At the error", "When filed"].map((h) => (
                  <th key={h} style={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {changed.map((key) => (
                <tr key={key}>
                  <td style={{ ...cell, color: "var(--muted)" }}>{key}</td>
                  <td style={{ ...cell, fontWeight: 600 }}>{show(atError[key])}</td>
                  <td style={{ ...cell, color: "var(--muted)" }}>{show(live[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : atError ? (
        <p className="muted" style={{ marginTop: 0 }}>
          Nothing changed between the error and filing — the state below is the state that failed.
        </p>
      ) : null}

      <details style={{ marginTop: "1rem" }}>
        <summary style={{ cursor: "pointer" }}>
          {atError ? "State at the error, in full" : "State, in full"}
        </summary>
        <Full snapshot={atError ?? live} />
      </details>
    </>
  );
}

/** Every field, for the questions the diff did not anticipate. */
function Full({ snapshot }: { snapshot: SessionSnapshot }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
      <tbody>
        {/* Reading order, not `Object.keys`: a snapshot that came back out of `jsonb` is sorted by
            key length, which lands `focusedLesson` twenty rows from `conversationLesson` — the one
            pair this table exists to let you compare. */}
        {orderedFields(snapshot).map((key) => (
          <tr key={key}>
            <td style={{ ...cell, color: "var(--muted)", width: "18ch" }}>{key}</td>
            <td style={cell}>{show(snapshot[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "✓" : "✗";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const head = {
  textAlign: "left" as const,
  padding: "0.35rem 0.6rem 0.35rem 0",
  borderBottom: "1px solid var(--border)",
  color: "var(--muted)",
  fontWeight: 600,
};

const cell = { padding: "0.35rem 0.6rem 0.35rem 0", borderBottom: "1px solid var(--border)" };
