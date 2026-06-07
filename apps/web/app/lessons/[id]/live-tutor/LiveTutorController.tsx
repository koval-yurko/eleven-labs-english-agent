"use client";

import { useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";
import {
  hasCapturableTurns,
  initialExchange,
  reduceExchange,
  shouldOfferReturnToLesson,
  type ExchangeState,
} from "../../../../lib/live-tutor/exchange-state";
import { usePlaybackQa } from "./usePlaybackQa";

/**
 * Orchestrates the hands-free live Q&A over the lesson <audio> (US1/US2/US4, R6/R7).
 * The ElevenLabs platform owns mic capture, VAD, barge-in, STT, and TTS; this component
 * is the glue: it pauses the lesson when the learner speaks, accumulates the exchange,
 * resumes from the exact interruption point when the learner goes quiet, and persists the
 * transcript afterwards (off the latency path). Turn-taking/barge-in is NOT reimplemented.
 */

type SessionStatus = "idle" | "connecting" | "live" | "unavailable";

// If the agent has answered and the learner stays silent this long, the exchange ends.
const RESUME_IDLE_MS = 1500;
// VAD score above which we treat the learner as speaking and pause the lesson.
const SPEECH_VAD_THRESHOLD = 0.6;

export function LiveTutorController({
  lessonId,
  audioRef,
}: {
  lessonId: string;
  audioRef: RefObject<HTMLAudioElement | null>;
}) {
  const [exchange, dispatch] = useReducer(reduceExchange, initialExchange);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const { isPlaying, captureAndPause, resumeFrom, setManualPaused } = usePlaybackQa(audioRef);

  // Mirror state into refs so the (stable) SDK callbacks always see the latest values, and
  // break the start/resume ↔ conversation declaration cycle.
  const exchangeRef = useRef<ExchangeState>(exchange);
  exchangeRef.current = exchange;
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const getConversationId = useRef<() => string | null>(() => null);

  const clearResumeTimer = useCallback(() => {
    if (resumeTimer.current) {
      clearTimeout(resumeTimer.current);
      resumeTimer.current = null;
    }
  }, []);

  const endExchangeAndResume = useCallback(() => {
    clearResumeTimer();
    const ex = exchangeRef.current;
    if (!ex.open) return;
    const position = ex.interruptionPositionSeconds ?? 0;

    // Persist AFTER deciding to resume; never block the answer/resume path (Constitution I).
    // An exchange with no real turns (background noise) is dropped, not saved (US4 edge).
    if (hasCapturableTurns(ex)) {
      void fetch(`/api/lessons/${lessonId}/exchanges`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interruptionPositionSeconds: position,
          elevenlabsConversationId: getConversationId.current(),
          turns: ex.turns,
        }),
      }).catch(() => {
        /* best-effort; a failed save must not disrupt playback */
      });
    }

    resumeFrom(position);
    dispatch({ type: "close" });
  }, [clearResumeTimer, lessonId, resumeFrom]);

  const scheduleResume = useCallback(() => {
    clearResumeTimer();
    resumeTimer.current = setTimeout(endExchangeAndResume, RESUME_IDLE_MS);
  }, [clearResumeTimer, endExchangeAndResume]);

  const conversation = useConversation({
    // Pause the lesson the instant the learner starts speaking (platform VAD → our pause).
    onVadScore: ({ vadScore }) => {
      if (vadScore < SPEECH_VAD_THRESHOLD) return;
      clearResumeTimer(); // detected speech (incl. a barge-in) cancels a pending resume
      if (!exchangeRef.current.open && isPlaying()) {
        dispatch({ type: "interrupt", positionSeconds: captureAndPause() });
      }
    },
    onMessage: ({ message, role }) => {
      const text = (message ?? "").trim();
      if (role === "user") {
        clearResumeTimer();
        if (!exchangeRef.current.open) {
          dispatch({ type: "interrupt", positionSeconds: captureAndPause() });
        }
        if (text.length === 0) dispatch({ type: "unintelligible" });
        else dispatch({ type: "learnerTurn", text });
      } else if (role === "agent" && text.length > 0) {
        dispatch({ type: "tutorTurn", text });
        // The tutor finished a thought; resume unless the learner barges in again.
        scheduleResume();
      }
    },
    onConnect: () => setStatus("live"),
    onError: () => setStatus("unavailable"),
  });

  // Keep the conversation-id getter current without threading `conversation` into the
  // resume callback's dependency cycle.
  getConversationId.current = () => {
    try {
      return conversation.getId() || null;
    } catch {
      return null;
    }
  };

  const start = useCallback(async () => {
    setStatus("connecting");
    const position = audioRef.current?.currentTime ?? 0;
    try {
      const res = await fetch(`/api/lessons/${lessonId}/live-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPositionSeconds: position }),
      });
      if (!res.ok) {
        setStatus("unavailable");
        return;
      }
      const token = (await res.json()) as {
        conversationToken: string;
        dynamicVariables: Record<string, string>;
      };
      // connectionType is auto-inferred as "webrtc" from the conversation token.
      conversation.startSession({
        conversationToken: token.conversationToken,
        dynamicVariables: token.dynamicVariables,
      });
    } catch {
      setStatus("unavailable");
    }
  }, [audioRef, conversation, lessonId]);

  const stop = useCallback(() => {
    clearResumeTimer();
    try {
      conversation.endSession();
    } catch {
      /* already disconnected */
    }
    setStatus("idle");
    dispatch({ type: "close" });
  }, [clearResumeTimer, conversation]);

  // Tear down the session on unmount or when the lesson finishes (R7 — bound the cost).
  useEffect(() => {
    const audio = audioRef.current;
    const onEnded = () => stop();
    audio?.addEventListener("ended", onEnded);
    return () => {
      audio?.removeEventListener("ended", onEnded);
      clearResumeTimer();
      try {
        conversation.endSession();
      } catch {
        /* noop */
      }
    };
    // Mount-once: set up teardown on unmount / lesson-end only.
  }, []);

  const offerReturn = shouldOfferReturnToLesson(exchange);

  return (
    <div className="panel" aria-live="polite">
      <strong>Live tutor</strong>
      {status === "idle" && (
        <div>
          <p className="muted" style={{ margin: "0.25rem 0" }}>
            Ask the teacher a question out loud any time — the lesson pauses while you talk
            and resumes where you left off.
          </p>
          <button
            onClick={() => {
              setManualPaused(false);
              void start();
            }}
          >
            🎤 Enable live Q&amp;A
          </button>
        </div>
      )}

      {status === "connecting" && <p className="muted">Connecting to your tutor…</p>}

      {status === "live" && (
        <div>
          <p className="ok" style={{ margin: "0.25rem 0" }}>
            🎤 Live — just speak to ask.{" "}
            {conversation.isSpeaking ? "Tutor is answering…" : "Listening…"}
          </p>
          {offerReturn && (
            <p className="warn" style={{ margin: "0.25rem 0" }}>
              Having trouble being understood?{" "}
              <button onClick={endExchangeAndResume}>Return to the lesson</button>
            </p>
          )}
          <button onClick={stop}>End live Q&amp;A</button>
        </div>
      )}

      {status === "unavailable" && (
        <div>
          <p className="warn" style={{ margin: "0.25rem 0" }}>
            Live tutor isn&apos;t available right now. Keep listening and try again later.
          </p>
          <button onClick={() => setStatus("idle")}>Try again</button>
        </div>
      )}
    </div>
  );
}
