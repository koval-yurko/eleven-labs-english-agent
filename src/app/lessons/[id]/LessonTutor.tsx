"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import {
  KICKOFF_MESSAGE,
  formatItemsList,
  type TranscriptLine,
  type TutorItem,
} from "../../../lib/tutor";
import { saveLessonSessionAction } from "../actions";

/**
 * Browser UI for one lesson's voice tutor. The word list comes from the lesson (server-side);
 * Start opens a mic conversation over a server-minted signed URL and injects the list as the
 * {{items_list}} dynamic variable. The agent leads; the learner can interrupt at any time
 * (barge-in is native to ElevenLabs convai). When the session ends, the transcript is saved
 * to the lesson's history right away — the post-call webhook enriches it later.
 */

/** A tutor prompt version offered in the picker (active versions from the lockfile registry). */
export type VersionOption = { version: string; label: string };

function Tutor({
  lessonId,
  items,
  versions,
  defaultVersion,
}: {
  lessonId: string;
  items: TutorItem[];
  versions: VersionOption[];
  defaultVersion: string;
}) {
  const router = useRouter();
  const [version, setVersion] = useState(defaultVersion);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kickedOff = useRef(false);

  // Mirrors for the SDK callbacks (they close over the first render's state).
  const linesRef = useRef<TranscriptLine[]>([]);
  const versionRef = useRef(defaultVersion);
  const conversationIdRef = useRef<string | null>(null);
  const savedForRef = useRef<string | null>(null);

  // Persist the finished conversation once per conversation id, then refresh the
  // server-rendered history below. Best-effort: a failed save must not break the UI.
  async function persistSession() {
    const conversationId = conversationIdRef.current;
    if (!conversationId || savedForRef.current === conversationId) return;
    if (linesRef.current.length === 0) return;
    savedForRef.current = conversationId;
    try {
      await saveLessonSessionAction({
        lessonId,
        conversationId,
        agentVersion: versionRef.current,
        lines: linesRef.current,
      });
      router.refresh();
    } catch {
      // History will still arrive via the post-call webhook.
    }
  }

  const conversation = useConversation({
    onConnect: ({ conversationId }) => {
      conversationIdRef.current = conversationId;
    },
    onMessage: ({ message, role }) => {
      // Don't show our hidden kickoff line — it's the trigger, not something the learner said.
      if (role === "user" && message === KICKOFF_MESSAGE) return;
      const line: TranscriptLine = { role, text: message };
      linesRef.current = [...linesRef.current, line];
      setLines(linesRef.current);
    },
    onDisconnect: () => {
      void persistSession();
    },
    onError: (message) => setError(message),
  });
  const { status, isSpeaking, startSession, endSession, sendUserMessage } = conversation;

  // Proactive kickoff: first_message is empty, so the instant we connect we send a hidden user
  // message — this reliably makes the agent take its opening turn (greet + teach the first item)
  // without the learner having to speak first.
  useEffect(() => {
    if (status === "connected" && !kickedOff.current) {
      kickedOff.current = true;
      sendUserMessage(KICKOFF_MESSAGE);
    }
    if (status === "disconnected") kickedOff.current = false;
  }, [status, sendUserMessage]);

  async function start() {
    setError(null);
    setStarting(true);
    try {
      // Prompt for the mic up front so a denial surfaces here, not mid-connect.
      await navigator.mediaDevices.getUserMedia({ audio: true });

      const res = await fetch(`/api/words-agent/signed-url?version=${encodeURIComponent(version)}`);
      const body = (await res.json()) as {
        signedUrl?: string;
        appEnv?: string;
        error?: { message: string };
      };
      if (!res.ok || !body.signedUrl) {
        throw new Error(body.error?.message ?? "Could not get a signed URL.");
      }

      setLines([]);
      linesRef.current = [];
      conversationIdRef.current = null;
      versionRef.current = version;
      startSession({
        signedUrl: body.signedUrl,
        connectionType: "websocket",
        dynamicVariables: {
          items_list: formatItemsList(items),
          // Ties the post-call webhook payload back to this lesson's history.
          lesson_id: lessonId,
          // Marks which deployment started this call; the post-call webhook routes on it.
          app_env: body.appEnv ?? "prod",
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  const connected = status === "connected";
  const busy = starting || status === "connecting";

  return (
    <>
      <section className="panel">
        <h2>Practice</h2>
        <p className="muted">
          Press start and discuss the words out loud with the tutor. Interrupt any time.
        </p>
        {versions.length > 1 ? (
          <label
            style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem" }}
          >
            <span className="muted">Tutor version</span>
            <select
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={connected || busy}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
          {connected ? (
            <button type="button" onClick={() => endSession()}>
              End session
            </button>
          ) : (
            <button type="button" onClick={start} disabled={busy}>
              {busy ? "Connecting…" : "Start conversation"}
            </button>
          )}
          <span className="muted">
            {connected
              ? isSpeaking
                ? "● teacher speaking — just talk to interrupt"
                : "● listening…"
              : `status: ${status}`}
          </span>
        </div>
        {error ? (
          <p className="muted" style={{ color: "var(--error)" }}>
            {error}
          </p>
        ) : null}
      </section>

      {lines.length > 0 ? (
        <section className="panel">
          <h2>Live transcript</h2>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {lines.map((l, i) => (
              <li key={i} style={{ marginBottom: "0.5rem" }}>
                <strong>{l.role === "agent" ? "Teacher" : "You"}:</strong>{" "}
                <span className="muted">{l.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function LessonTutor(props: {
  lessonId: string;
  items: TutorItem[];
  versions: VersionOption[];
  defaultVersion: string;
}) {
  return (
    <ConversationProvider>
      <Tutor {...props} />
    </ConversationProvider>
  );
}
