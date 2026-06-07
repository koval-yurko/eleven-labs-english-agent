"use client";

import type { Caption } from "../../../../lib/live-story/narration-state";

/**
 * Live subtitle captions of both voices (US4, FR-018/FR-019). Each entry is a finalized,
 * attributed turn; a barge-in-truncated teacher turn shows only what was actually spoken
 * (its text is corrected upstream in the hook — R5/SC-008). No karaoke/word-sync; this is
 * deliberately subtitle-level.
 */
export function CaptionLog({ captions }: { captions: Caption[] }) {
  if (captions.length === 0) return null;
  return (
    <div className="panel" aria-live="polite" aria-label="Live captions">
      <strong className="muted">Captions</strong>
      <ul style={{ listStyle: "none", padding: 0, margin: "0.25rem 0 0" }}>
        {captions.map((c, i) => (
          <li key={i} style={{ margin: "0.35rem 0" }}>
            <span className={c.role === "teacher" ? "ok" : "muted"} style={{ fontWeight: 600 }}>
              {c.role === "teacher" ? "Teacher" : "You"}
              {c.kind === "scenario_change" ? " (setting)" : c.kind === "question" ? " (question)" : ""}:
            </span>{" "}
            {c.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
