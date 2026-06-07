"use client";

import { useEffect, useState } from "react";
import type { LiveSession, TranscriptDTO } from "@idiomatic/contracts";

/**
 * Durable transcript review (US5, FR-024). Fetches the lesson's past live-story sessions
 * (narration + Q&A, corrected text, in order, attributed) and renders them as the
 * replayable record — there is NO audio player (FR-025; no realtime audio is ever stored).
 * Re-fetched when `refreshKey` changes (e.g. after a live session ends).
 */
export function TranscriptReview({ lessonId, refreshKey = 0 }: { lessonId: string; refreshKey?: number }) {
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/lessons/${lessonId}/transcript`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as TranscriptDTO;
        if (active) setSessions(data.sessions);
      } catch {
        /* a failed transcript read just shows nothing — non-blocking */
      }
    })();
    return () => {
      active = false;
    };
  }, [lessonId, refreshKey]);

  if (!sessions || sessions.length === 0) return null;

  return (
    <div className="panel">
      <strong>Live story transcript</strong>
      {sessions.map((s) => (
        <div key={s.id} style={{ marginTop: "0.5rem" }}>
          <p className="muted" style={{ margin: "0.25rem 0", fontSize: "0.85em" }}>
            {new Date(s.createdAt).toLocaleString()}
            {s.scenario ? ` · setting: ${s.scenario}` : ""}
            {s.status === "active" ? " · (unfinished)" : ""}
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {s.turns.map((t) => (
              <li key={t.turnIndex} style={{ margin: "0.3rem 0" }}>
                <span className={t.role === "teacher" ? "ok" : "muted"} style={{ fontWeight: 600 }}>
                  {t.role === "teacher" ? "Teacher" : "You"}
                  {t.kind === "scenario_change"
                    ? " (setting)"
                    : t.kind === "question"
                      ? " (question)"
                      : t.kind === "answer"
                        ? " (answer)"
                        : ""}
                  :
                </span>{" "}
                {t.text}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
