import {
  type ProviderVerdict,
  isQuotaVerdict,
  verdictErrorLabel,
} from "../../../../lib/debug-report-verdict";

/**
 * What the provider recorded about each conversation in the report — the half of a failure the
 * phone never sees.
 *
 * It sits directly under the headline, above Identity, and that placement is the point: on reports
 * `47a7f19c` and `470ddc9f` everything below it was a faithful account of how the app behaved while
 * the account was out of credits, and none of it said why. When the provider names the cause, the
 * rest of the page is context.
 *
 * Renders nothing when there is nothing to say — a provider with no per-conversation record, a
 * session that never got a row key, or a lookup that did not answer. A missing section is a far
 * smaller loss than a panel announcing that it has no information.
 */
export function Verdicts({ verdicts }: { verdicts: ProviderVerdict[] }) {
  if (verdicts.length === 0) return null;
  return (
    <section className="panel">
      <h2>What ElevenLabs recorded</h2>
      {verdicts.some(isQuotaVerdict) ? (
        <p className="error" style={{ marginTop: 0 }}>
          The ElevenLabs account was out of credits. That is the cause, and it is not in the code —
          the account needs topping up.
        </p>
      ) : null}
      <p className="muted" style={{ marginTop: 0 }}>
        The provider&apos;s own record of each conversation in the timeline, oldest first. The phone
        never sees these fields — a refusal reaches it as “Unknown error”, or as no error at all.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
        <thead>
          <tr>
            {["Conversation", "Status", "Duration", "Ended because"].map((h) => (
              <th key={h} style={head}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {verdicts.map((v) => {
            const label = verdictErrorLabel(v);
            return (
              <tr key={v.conversationId}>
                <td style={cell}>
                  <code>{v.conversationId}</code>
                </td>
                <td style={cell}>{v.status ?? "?"}</td>
                <td style={cell}>{v.durationSecs !== null ? `${v.durationSecs}s` : "?"}</td>
                <td style={cell}>
                  {v.reason ? (
                    <>
                      {v.reason}
                      {label ? <span className="muted"> · {label}</span> : null}
                    </>
                  ) : (
                    <span className="muted">no reason recorded — an ordinary hangup</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

const head = {
  textAlign: "left" as const,
  padding: "0.35rem 0.6rem 0.35rem 0",
  borderBottom: "1px solid var(--border)",
  color: "var(--muted)",
  fontWeight: 600,
};

const cell = {
  padding: "0.35rem 0.6rem 0.35rem 0",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top" as const,
};
