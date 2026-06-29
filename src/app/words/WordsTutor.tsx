"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";

/**
 * Browser UI for the English-words-tutor voice agent. A textbox supplies the items (words OR
 * phrases/sentences, one per line); Start opens a mic conversation over a server-minted signed
 * URL and injects the list as the {{items_list}} dynamic variable. The agent leads; the learner
 * can interrupt and ask follow-ups at any time (barge-in is native to ElevenLabs convai).
 *
 * See docs/2026-06-26-minimal-english-words-voice-agent.md.
 */

type Line = { role: "user" | "agent"; text: string };

/** A tutor prompt version offered in the picker (active versions from the lockfile registry). */
export type VersionOption = { version: string; label: string };

const PLACEHOLDER = `ephemeral
break the ice
I couldn't agree more`;

// Hidden message we send to the agent the instant we connect, so it greets and starts teaching
// the first item ON ITS OWN — the learner never has to speak first. An empty first_message makes
// the agent wait; a user message reliably triggers its opening (LLM-generated) turn. Suppressed
// from the transcript below so it reads as the teacher speaking first.
const KICKOFF = "Let's begin. Greet me in one sentence and start teaching the first item now.";

function Tutor({ versions, defaultVersion }: { versions: VersionOption[]; defaultVersion: string }) {
  const [raw, setRaw] = useState(PLACEHOLDER);
  const [version, setVersion] = useState(defaultVersion);
  const [lines, setLines] = useState<Line[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kickedOff = useRef(false);

  const conversation = useConversation({
    onMessage: ({ message, role }) => {
      // Don't show our hidden kickoff line — it's the trigger, not something the learner said.
      if (role === "user" && message === KICKOFF) return;
      setLines((prev) => [...prev, { role, text: message }]);
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
      sendUserMessage(KICKOFF);
    }
    if (status === "disconnected") kickedOff.current = false;
  }, [status, sendUserMessage]);

  async function start() {
    setError(null);
    const items = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length === 0) {
      setError("Add at least one word or sentence to discuss.");
      return;
    }

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
      startSession({
        signedUrl: body.signedUrl,
        connectionType: "websocket",
        dynamicVariables: {
          items_list: items.map((it, i) => `${i + 1}. ${it}`).join("; "),
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
        <h2>Words to discuss</h2>
        <p className="muted">One word, phrase, or sentence per line. The tutor teaches each one.</p>
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
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={5}
          disabled={connected || busy}
          style={{ width: "100%", fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
          {connected ? (
            <button type="button" onClick={() => endSession()}>
              End session
            </button>
          ) : (
            <button type="button" onClick={start} disabled={busy}>
              {busy ? "Connecting…" : "Start lesson"}
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
          <h2>Transcript</h2>
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

export function WordsTutor({
  versions,
  defaultVersion,
}: {
  versions: VersionOption[];
  defaultVersion: string;
}) {
  return (
    <ConversationProvider>
      <Tutor versions={versions} defaultVersion={defaultVersion} />
    </ConversationProvider>
  );
}
