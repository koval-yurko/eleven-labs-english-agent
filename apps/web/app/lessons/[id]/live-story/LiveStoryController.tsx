"use client";

import { useEffect, useRef } from "react";
import { CaptionLog } from "./CaptionLog";
import { useLiveStory } from "./useLiveStory";

/**
 * Orchestrates the adaptive live-narrated lesson (US1, R1). POSTs to start, then the agent
 * narrates beat-by-beat over the realtime session — there is NO `<audio>` element. The
 * platform owns turn-taking/barge-in/STT/TTS; this component only renders state and bounds
 * the session (teardown on stop/navigate/conclude). Scenario steering (US2), barge-in Q&A
 * (US3), captions (US4), transcript persistence (US5), and the unavailable fallback (US6)
 * extend this component and its hook.
 */
export function LiveStoryController({
  lessonId,
  onSessionEnd,
}: {
  lessonId: string;
  onSessionEnd?: () => void;
}) {
  const { status, start, stop, returnToNarration, captions, coverage, scenario, offerReturn, isSpeaking } =
    useLiveStory(lessonId);

  // Tear the session down on unmount/navigate (bound the Conversational-AI minutes, R10).
  // `stop` is a stable callback, so the cleanup runs only on unmount.
  useEffect(() => () => stop(), [stop]);

  // When a session reaches "ended", nudge the parent to re-fetch the durable transcript so it
  // appears without a manual reload (FR-024). Fire once per ended transition.
  const endedNotifiedRef = useRef(false);
  useEffect(() => {
    if (status === "ended" && !endedNotifiedRef.current) {
      endedNotifiedRef.current = true;
      onSessionEnd?.();
    }
    if (status !== "ended") endedNotifiedRef.current = false;
  }, [status, onSessionEnd]);

  return (
    <div className="panel" aria-live="polite">
      <strong>Live Story</strong>

      {status === "idle" && (
        <div>
          <p className="muted" style={{ margin: "0.25rem 0" }}>
            Hear this lesson told live as a story. Speak any time to ask a question or change
            the setting — the teacher adapts and still covers every item.
          </p>
          <button onClick={() => void start()}>🎤 Start live story</button>
        </div>
      )}

      {status === "connecting" && <p className="muted">Starting your live story…</p>}

      {status === "live" && (
        <div>
          <p className="ok" style={{ margin: "0.25rem 0" }}>
            🎤 Live — {isSpeaking ? "the teacher is narrating…" : "listening…"}
          </p>
          <p className="muted" style={{ margin: "0.25rem 0" }}>
            {coverage.total - coverage.remaining}/{coverage.total} items taught
            {scenario ? ` · setting: ${scenario}` : ""}
          </p>
          {offerReturn && (
            <p className="warn" style={{ margin: "0.25rem 0" }}>
              Having trouble being understood?{" "}
              <button onClick={returnToNarration}>Return to the story</button>
            </p>
          )}
          <button onClick={stop}>End live story</button>
        </div>
      )}

      {status === "ended" && (
        <p className="ok" style={{ margin: "0.25rem 0" }}>
          ✓ Live story finished. Your transcript is saved below.
        </p>
      )}

      {status === "unavailable" && (
        <div>
          <p className="warn" style={{ margin: "0.25rem 0" }}>
            The live story isn&apos;t available right now. Please try again in a little while.
            {captions.length > 0 ? " Your transcript so far is saved below." : ""}
          </p>
          <button onClick={() => void start()}>Try again</button>
        </div>
      )}

      {(status === "live" || status === "ended" || status === "unavailable") && (
        <CaptionLog captions={captions} />
      )}
    </div>
  );
}
