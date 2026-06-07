"use client";

import { useConversation } from "@elevenlabs/react";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { AppendTurnRequest, LessonPlan, StartStoryToken } from "@idiomatic/contracts";
import {
  buildClientTools,
  type ClientToolsHost,
} from "../../../../lib/live-story/client-tools";
import {
  appendCaption,
  type Caption,
  correctLastTeacherCaption,
  createNarrationState,
  noteLearnerSpeech,
  noteUnintelligible,
  remainingItems,
  shouldOfferReturnToLesson,
  type NarrationState,
} from "../../../../lib/live-story/narration-state";
import { scenarioPinText } from "../../../../lib/live-story/plan-context";

/**
 * Binds the ElevenLabs realtime session to the pure narration state machine (US1, R1/R3).
 * The platform owns mic/VAD/barge-in/STT/TTS; this hook is the glue: it builds the
 * `clientTools` the narrator agent calls (advanceNarration/markItemTaught/concludeLesson),
 * kicks off narration on connect, mirrors narration state for the UI, and tears the session
 * down on conclude/stop. Captions (US4), scenario re-pin (US2), Q&A routing (US3), and
 * incremental persistence (US5) extend this same hook.
 */

export type LiveStoryStatus = "idle" | "connecting" | "live" | "ended" | "unavailable";

type StartResponse = StartStoryToken & { plan: LessonPlan };

const KICKOFF = "Begin narrating the lesson now, starting with beat 1.";
// Grace period after the agent is cleared to conclude, to let it speak the closing line.
const CONCLUDE_GRACE_MS = 6000;

export function useLiveStory(lessonId: string) {
  const [status, setStatus] = useState<LiveStoryStatus>("idle");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [, forceTick] = useReducer((x: number) => x + 1, 0);

  const stateRef = useRef<NarrationState | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const concludingRef = useRef(false);
  const convRef = useRef<ReturnType<typeof useConversation> | null>(null);
  const concludeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Teacher-turn bookkeeping so a barge-in correction overwrites the SAME turn in caption AND
  // transcript (R5/R6) — one corrected-text code path.
  const teacherSeqRef = useRef(0);
  const lastTeacherRef = useRef<string | null>(null);
  const lastTeacherKindRef = useRef<"narration" | "answer">("narration");
  const awaitingAnswerRef = useRef(false);

  const getConversationId = useRef<() => string | null>(() => null);

  /**
   * Persist finalized turns / session updates incrementally — best-effort and OFF the
   * speech path (Constitution I, FR-027). A failed write must never disrupt narration.
   */
  const persistTurns = useCallback(
    (
      turns: AppendTurnRequest["turns"],
      extra: Partial<Pick<AppendTurnRequest, "scenario" | "ended" | "elevenlabsConversationId">> = {},
    ) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      const body: AppendTurnRequest = {
        sessionId,
        turns,
        elevenlabsConversationId: getConversationId.current(),
        ...extra,
      };
      void fetch(`/api/lessons/${lessonId}/live-story/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {
        /* best-effort; persistence must not disrupt the live session */
      });
    },
    [lessonId],
  );

  // Set true when teardown is requested, so the next persisted turn carries `ended:true`
  // (the append route requires ≥1 turn, so ending rides with the final captured turn, R6).
  const endRequestedRef = useRef(false);

  const finish = useCallback(() => {
    if (concludeTimer.current) clearTimeout(concludeTimer.current);
    endRequestedRef.current = true;
    try {
      convRef.current?.endSession();
    } catch {
      /* already disconnected */
    }
    setStatus("ended");
  }, []);

  // The client-tools host: stateless SDK callbacks read/write the narration state here.
  const host = useMemo<ClientToolsHost>(
    () => ({
      getState: () => {
        if (!stateRef.current) throw new Error("narration not started");
        return stateRef.current;
      },
      setState: (next) => {
        stateRef.current = next;
        forceTick();
        // Once the agent is cleared to conclude, mark the session ending (so the closing
        // narration line persists with `ended:true`, R6) and end after a short grace.
        if (next.concluded && !concludingRef.current) {
          concludingRef.current = true;
          endRequestedRef.current = true;
          concludeTimer.current = setTimeout(finish, CONCLUDE_GRACE_MS);
        }
      },
      onScenarioChange: (scenario) => {
        // Re-pin the new setting for the rest of the session (R4) and record it as a
        // scenario_change turn (the learner requested it) — latest wins (FR-009).
        try {
          convRef.current?.sendContextualUpdate(scenarioPinText(scenario));
        } catch {
          /* best-effort steering */
        }
        persistTurns([{ role: "learner", kind: "scenario_change", text: scenario }], { scenario });
      },
    }),
    [finish, persistTurns],
  );

  const clientTools = useMemo(() => buildClientTools(host), [host]);

  const conversation = useConversation({
    clientTools,
    onConnect: () => {
      setStatus("live");
      // Kick off the self-continuation narration loop (R1).
      try {
        convRef.current?.sendContextualUpdate(KICKOFF);
      } catch {
        /* the contextual update is best-effort */
      }
    },
    // Finalized, subtitle-level turns (R5). Learner turns drive the clarification guard
    // (US3); teacher turns drive captions (US4); both are persisted incrementally (US5).
    // We deliberately consume ONLY onMessage (finalized) — never the tentative stream (R5).
    onMessage: ({ message, source }) => {
      if (!stateRef.current) return;
      const text = (message ?? "").trim();
      if (source === "user") {
        if (text.length === 0) {
          // Empty/unintelligible: never a stored turn, just nudge the guard (FR-016, R9).
          host.setState(noteUnintelligible(stateRef.current));
          return;
        }
        host.setState(noteLearnerSpeech(stateRef.current));
        awaitingAnswerRef.current = true; // the teacher's next turn answers this question
        setCaptions((cs) => appendCaption(cs, { role: "learner", kind: "question", text, ref: null }));
        persistTurns([{ role: "learner", kind: "question", text }]);
      } else {
        // source === "ai" → the teacher (narration, or an answer if a question is pending).
        if (text.length === 0) return;
        const ref = `teacher-${teacherSeqRef.current++}`;
        const kind = awaitingAnswerRef.current ? "answer" : "narration";
        awaitingAnswerRef.current = false;
        lastTeacherRef.current = ref;
        lastTeacherKindRef.current = kind;
        setCaptions((cs) => appendCaption(cs, { role: "teacher", kind, text, ref }));
        // If teardown was requested, this final turn carries `ended:true` (R6).
        const ended = endRequestedRef.current;
        if (ended) endRequestedRef.current = false;
        persistTurns([{ role: "teacher", kind, text, elevenTurnRef: ref }], ended ? { ended: true } : {});
      }
    },
    // Barge-in truncation: replace the just-rendered teacher turn's text with what was
    // actually spoken, in caption AND transcript (one path, R5/SC-008/FR-020/FR-022).
    onAgentResponseCorrection: ({ corrected_agent_response }) => {
      const corrected = (corrected_agent_response ?? "").trim();
      if (corrected.length === 0) return;
      setCaptions((cs) => correctLastTeacherCaption(cs, corrected));
      const ref = lastTeacherRef.current;
      if (ref) {
        persistTurns([
          { role: "teacher", kind: lastTeacherKindRef.current, text: corrected, elevenTurnRef: ref },
        ]);
      }
    },
    onError: () => setStatus("unavailable"),
    onDisconnect: (details) => {
      // A natural conclude or a user-initiated stop is fine. An UNEXPECTED drop mid-session
      // (transport error / agent-side close) surfaces the clear retry fallback — never a
      // frozen screen — while the partial transcript already written is preserved (US6, R7).
      if (concludingRef.current) return;
      if (details?.reason === "user") return;
      setStatus("unavailable");
    },
  });
  convRef.current = conversation;
  getConversationId.current = () => {
    try {
      return conversation.getId() || null;
    } catch {
      return null;
    }
  };

  const start = useCallback(async () => {
    setStatus("connecting");
    concludingRef.current = false;
    endRequestedRef.current = false;
    teacherSeqRef.current = 0;
    lastTeacherRef.current = null;
    awaitingAnswerRef.current = false;
    setCaptions([]);
    try {
      const res = await fetch(`/api/lessons/${lessonId}/live-story`, { method: "POST" });
      if (!res.ok) {
        setStatus("unavailable");
        return;
      }
      const data = (await res.json()) as StartResponse;
      sessionIdRef.current = data.sessionId;
      stateRef.current = createNarrationState(data.plan);
      forceTick();
      conversation.startSession({
        conversationToken: data.conversationToken,
        dynamicVariables: data.dynamicVariables,
        clientTools,
      });
    } catch {
      setStatus("unavailable");
    }
  }, [clientTools, conversation, lessonId]);

  const stop = useCallback(() => {
    finish();
  }, [finish]);

  // FR-017 escape: after repeated unintelligible input, let the learner drop back into the
  // narration cleanly rather than being trapped in a clarification loop.
  const returnToNarration = useCallback(() => {
    if (stateRef.current) {
      stateRef.current = { ...stateRef.current, clarificationStreak: 0 };
      forceTick();
    }
    try {
      convRef.current?.sendContextualUpdate("Please continue the lesson where you left off.");
    } catch {
      /* best-effort */
    }
  }, []);

  const narration = stateRef.current;
  const coverage = narration
    ? { total: narration.items.length, remaining: remainingItems(narration).length }
    : { total: 0, remaining: 0 };

  return {
    status,
    setStatus,
    start,
    stop,
    returnToNarration,
    captions,
    coverage,
    scenario: narration?.scenario ?? null,
    offerReturn: narration ? shouldOfferReturnToLesson(narration) : false,
    isSpeaking: conversation.isSpeaking,
  };
}
