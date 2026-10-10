import type { DebugEvent } from "@tutor/shared/debug/report";
import { isKnownDebugCode } from "@tutor/shared/debug/codes";

/**
 * The ring, **oldest first** — the opposite of the phone.
 *
 * On the device the log is newest-first because you have just watched something fail and want it at
 * the top. Here you are reading a story from the beginning: what the status was, whether the mint
 * answered, whether ownership was claimed, and then the thing that went wrong. Reversing it would
 * make every investigation scroll to the bottom and read upward.
 *
 * A **sequence gap is rendered explicitly**. `seq` is monotonic across the process, so a jump means
 * the ring evicted events — and a truncated log that looks complete is worse than one that says so.
 */
export function Timeline({ events }: { events: DebugEvent[] }) {
  if (events.length === 0) {
    return <p className="muted">No events. The report was filed before anything was recorded.</p>;
  }
  // Copied before sorting: the array is the row's jsonb, and mutating it in place would reorder
  // what the raw-JSON section below renders.
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const first = ordered[0];

  return (
    <div style={{ display: "grid", gap: "0.15rem" }}>
      {ordered.map((event, i) => {
        const previous = ordered[i - 1];
        const gap = previous ? event.seq - previous.seq - 1 : 0;
        return (
          <div key={event.seq}>
            {gap > 0 ? (
              <p className="muted" style={{ textAlign: "center", margin: "0.35rem 0" }}>
                — {gap} event{gap === 1 ? "" : "s"} dropped —
              </p>
            ) : null}
            <Event event={event} since={first ? event.since - first.since : 0} />
          </div>
        );
      })}
    </div>
  );
}

function Event({ event, since }: { event: DebugEvent; since: number }) {
  const tone =
    event.level === "error" ? "error" : event.level === "warn" ? "warn" : "muted";
  return (
    <details
      style={{
        borderLeft: `2px solid var(--${event.level === "error" ? "error" : event.level === "warn" ? "warn" : "border"})`,
        paddingLeft: "0.6rem",
      }}
    >
      <summary style={{ cursor: "pointer", listStyle: "none" }}>
        {/* The relative gutter, fixed-width so the column reads as a column. It is relative to the
            FIRST event in the report rather than to the session start, because a report can begin
            before a session does — `since` is negative there, deliberately. */}
        <code className="muted" style={{ display: "inline-block", minWidth: "5.5ch" }}>
          +{(since / 1000).toFixed(1)}s
        </code>{" "}
        <code className={tone}>{event.code}</code>
        {/* A code this deployment has never heard of is LABELLED, never dropped — the whole point
            of the registry being open at the edge of the server (`debug/codes.ts`). */}
        {isKnownDebugCode(event.code) ? null : (
          <span className="warn" title="This build does not know this code — it came from a newer or older phone">
            {" "}
            ?
          </span>
        )}
        {event.provider ? <span className="muted"> [{event.provider}]</span> : null}{" "}
        <span>{event.message}</span>
      </summary>
      <div style={{ padding: "0.35rem 0 0.5rem" }}>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          seq {event.seq} · {event.at}
        </p>
        {event.data ? (
          <pre style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
            {Object.entries(event.data)
              .map(([k, v]) => `${k}: ${String(v)}`)
              .join("\n")}
          </pre>
        ) : null}
      </div>
    </details>
  );
}
