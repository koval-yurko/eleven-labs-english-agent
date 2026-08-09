"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import {
  HIDDEN_KICKOFF_MESSAGES,
  KICKOFF_MESSAGE,
  RESUME_MESSAGE,
  formatItemsList,
  formatResumeContext,
  type TranscriptLine,
  type TutorItem,
} from "@tutor/shared/tutor";
import { isApiError, isSignedUrlResponse, signedUrlPath } from "@tutor/shared/api";
import { saveLessonSessionAction } from "../actions";
import { Select } from "../../Select";
import { InfoPopover } from "../../InfoPopover";
import { Button } from "../../Button";
import { useKeepAwake } from "./useKeepAwake";
import { useAudioHealth } from "./useAudioHealth";
import { beaconJournal, clearJournal, readJournal, writeJournal } from "./session-journal";

/**
 * Browser UI for one lesson's voice tutor. The word list comes from the lesson (server-side);
 * Start opens a mic conversation over a server-minted signed URL and injects the list as the
 * {{items_list}} dynamic variable. The agent leads; the learner can interrupt at any time
 * (barge-in is native to ElevenLabs convai). When the session ends, the transcript is saved
 * to the lesson's history right away — the post-call webhook enriches it later.
 *
 * Everything past the conversation itself is about surviving iOS. A web page cannot run a voice
 * session in the background — the mic is revoked, Web Audio is interrupted and the socket is
 * dropped the moment Safari leaves the foreground (docs/2026-08-07-ios-locked-screen-background-voice.md).
 * So the contract here is "alive for as long as the tab is open, and honest the instant it isn't":
 *
 *   - the screen is held awake by `useKeepAwake` (we own the wake lock; the SDK's is disabled), and
 *     a failure to hold it is shown rather than swallowed;
 *   - `useAudioHealth` catches the case where iOS interrupts the audio graph and the session would
 *     otherwise sit there looking connected while nobody can hear anybody;
 *   - hiding the page for more than a moment ends the session deterministically, saving the
 *     transcript while JS can still run, and offers a Resume that carries the context over;
 *   - every line is journalled to IndexedDB and beaconed on `pagehide`, so a discarded tab
 *     cannot lose the conversation.
 *
 * See docs/2026-08-07-ios-keep-session-alive-foreground.md.
 */

/** A tutor prompt version offered in the picker (active versions from the lockfile registry). */
export type VersionOption = { version: string; label: string };

/** Why the session is not running — each renders its own Resume card. */
type PauseReason =
  | "background" // iOS suspended the page (app switch / lock) and we ended the session cleanly
  | "audio" // the audio graph was interrupted (call, Siri, notification, route change)
  | "recovered"; // a previous session's transcript was found on load

/** How long the page may be hidden before we give up on it — long enough to survive a swipe. */
const HIDE_GRACE_MS = 2000;
/** Minimum gap between `sendUserActivity` pings (they only exist to prevent an idle hang-up). */
const ACTIVITY_PING_MS = 15_000;

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
  // VersionOption is already {value-ish, label}; map it once to the Select's shape.
  const versionOptions = useMemo(
    () => versions.map((v) => ({ value: v.version, label: v.label })),
    [versions],
  );
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  // Turns from earlier, interrupted conversations of the same sitting. Kept out of `lines` so each
  // conversation is saved under its own id and nothing is stored twice; shown together below.
  const [carried, setCarried] = useState<TranscriptLine[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pause, setPause] = useState<PauseReason | null>(null);
  const kickedOff = useRef(false);

  // Mirrors for the SDK callbacks (they close over the first render's state).
  const linesRef = useRef<TranscriptLine[]>([]);
  const versionRef = useRef(defaultVersion);
  const conversationIdRef = useRef<string | null>(null);
  const savedForRef = useRef<string | null>(null);
  // Transcript of an interrupted session, replayed to the next one as context.
  const resumeContextRef = useRef<TranscriptLine[] | null>(null);

  /** The journal/beacon payload for whatever is being said right now. */
  const snapshot = useCallback(
    () => ({
      lessonId,
      conversationId: conversationIdRef.current,
      agentVersion: versionRef.current,
      lines: linesRef.current,
    }),
    [lessonId],
  );

  // Persist the finished conversation once per conversation id, then refresh the
  // server-rendered history below. Best-effort: a failed save must not break the UI.
  const persistSession = useCallback(async () => {
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
      await clearJournal(lessonId);
      router.refresh();
    } catch {
      // History will still arrive via the post-call webhook, and the journal keeps the local copy.
    }
  }, [lessonId, router]);

  const conversation = useConversation({
    onConnect: ({ conversationId }) => {
      conversationIdRef.current = conversationId;
    },
    onMessage: ({ message, role }) => {
      // Don't show our hidden kickoff lines — they're the trigger, not something the learner said.
      if (role === "user" && HIDDEN_KICKOFF_MESSAGES.includes(message)) return;
      const line: TranscriptLine = { role, text: message };
      linesRef.current = [...linesRef.current, line];
      setLines(linesRef.current);
      // Journal as we go: iOS can discard this tab without ever running `onDisconnect`.
      void writeJournal(snapshot());
    },
    onDisconnect: () => {
      void persistSession();
    },
    onError: (message) => setError(message),
  });
  const {
    status,
    isSpeaking,
    startSession,
    endSession,
    sendUserMessage,
    sendContextualUpdate,
    sendUserActivity,
    getInputVolume,
    getOutputVolume,
  } = conversation;

  const connected = status === "connected";
  const keepAwake = useKeepAwake(connected);
  const { health, resume: resumeAudio } = useAudioHealth({
    active: connected,
    getInputVolume,
    getOutputVolume,
  });

  // Proactive kickoff: first_message is empty, so the instant we connect we send a hidden user
  // message — this reliably makes the agent take its opening turn (greet + teach the first item)
  // without the learner having to speak first. A resumed session gets the interrupted
  // conversation as context first, so it continues instead of starting the lesson over.
  useEffect(() => {
    if (status === "connected" && !kickedOff.current) {
      kickedOff.current = true;
      const resumeFrom = resumeContextRef.current;
      resumeContextRef.current = null;
      if (resumeFrom && resumeFrom.length > 0) {
        sendContextualUpdate(formatResumeContext(resumeFrom));
        sendUserMessage(RESUME_MESSAGE);
      } else {
        sendUserMessage(KICKOFF_MESSAGE);
      }
    }
    if (status === "disconnected") kickedOff.current = false;
  }, [status, sendUserMessage, sendContextualUpdate]);

  /**
   * End the session on purpose and offer to pick it up again. Saves twice on purpose: the beacon
   * survives a page that is about to be frozen, `endSession` → `onDisconnect` → `persistSession`
   * covers the ordinary case. Both are idempotent (upsert by conversation_id).
   */
  const pauseSession = useCallback(
    (reason: PauseReason) => {
      if (linesRef.current.length > 0) {
        resumeContextRef.current = linesRef.current;
        void writeJournal(snapshot());
        beaconJournal(snapshot());
      }
      setPause(reason);
      endSession();
    },
    [endSession, snapshot],
  );

  // Effects below are registered once per connection; going through a ref keeps a re-render (every
  // transcript line causes one) from resetting the hide grace timer.
  const pauseRef = useRef(pauseSession);
  pauseRef.current = pauseSession;

  // A short hide is a notification pull-down or a fat-fingered swipe — don't kill the lesson for
  // it. A longer one means iOS has taken the microphone away, so end cleanly while JS still runs.
  useEffect(() => {
    if (!connected) return;
    let timer: number | null = null;
    const clear = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const onVisibility = () => {
      clear();
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(() => pauseRef.current("background"), HIDE_GRACE_MS);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [connected]);

  // The audio graph died under us (call, Siri, notification, headphones). The SDK cannot recover
  // its worklets, so stop pretending and offer a restart.
  useEffect(() => {
    if (connected && health === "interrupted") pauseRef.current("audio");
  }, [connected, health]);

  // Last-gasp save: `pagehide`/`freeze` fire before iOS suspends or discards the page, and a
  // beacon is queued by the browser even as the page goes away (a fetch would not be).
  useEffect(() => {
    if (!connected) return;
    const flush = () => {
      beaconJournal(snapshot());
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("freeze", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("freeze", flush);
    };
  }, [connected, snapshot]);

  // Tell the agent the learner is still there, so a long thinking pause isn't read as an idle
  // conversation and hung up on. Throttled — this is a liveness hint, not an event stream.
  useEffect(() => {
    if (!connected) return;
    let last = 0;
    const ping = () => {
      const now = Date.now();
      if (now - last < ACTIVITY_PING_MS) return;
      last = now;
      sendUserActivity();
    };
    const passive = { passive: true } as const;
    window.addEventListener("pointerdown", ping, passive);
    window.addEventListener("keydown", ping);
    window.addEventListener("scroll", ping, passive);
    return () => {
      window.removeEventListener("pointerdown", ping);
      window.removeEventListener("keydown", ping);
      window.removeEventListener("scroll", ping);
    };
  }, [connected, sendUserActivity]);

  // A journal left behind means the last session died without saving (discarded tab, hard suspend).
  // Push it to the server, then offer to carry on from where it stopped.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const journal = await readJournal(lessonId);
      if (cancelled || !journal || journal.lines.length === 0) return;
      if (journal.conversationId) {
        try {
          await saveLessonSessionAction({
            lessonId,
            conversationId: journal.conversationId,
            agentVersion: journal.agentVersion,
            lines: journal.lines,
          });
          router.refresh();
        } catch {
          // The post-call webhook is the backstop; the lines are still offered as context below.
        }
      }
      await clearJournal(lessonId);
      if (cancelled) return;
      setCarried(journal.lines);
      resumeContextRef.current = journal.lines;
      setPause("recovered");
    })();
    return () => {
      cancelled = true;
    };
  }, [lessonId, router]);

  async function start() {
    setError(null);
    setStarting(true);
    try {
      // Prompt for the mic up front so a denial surfaces here, not mid-connect.
      await navigator.mediaDevices.getUserMedia({ audio: true });

      const res = await fetch(signedUrlPath(version));
      const body: unknown = await res.json();
      if (!res.ok || !isSignedUrlResponse(body)) {
        throw new Error(
          isApiError(body) ? body.error.message : "Could not get a signed URL.",
        );
      }

      const resuming = (resumeContextRef.current?.length ?? 0) > 0;
      // Either way the next conversation starts with an empty transcript of its own; resuming
      // moves what was already said into the read-only carried block above it.
      setCarried(resuming ? (prev) => [...prev, ...linesRef.current] : []);
      setLines([]);
      linesRef.current = [];
      await clearJournal(lessonId);
      conversationIdRef.current = null;
      versionRef.current = version;
      setPause(null);
      startSession({
        signedUrl: body.signedUrl,
        connectionType: "websocket",
        // We hold the screen ourselves (useKeepAwake) — the SDK's wake lock is silent about
        // failures and never retries once its first request fails.
        useWakeLock: false,
        dynamicVariables: {
          items_list: formatItemsList(items),
          // Ties the post-call webhook payload back to this lesson's history.
          lesson_id: lessonId,
          // Marks which deployment started this call; the post-call webhook routes on it.
          // No fallback: `isSignedUrlResponse` already rejected a response without one, because
          // defaulting it would file this session under the wrong environment.
          app_env: body.appEnv,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  /** Resume from the pause card: revive the audio session inside the tap, then reconnect. */
  async function resumeSession() {
    await resumeAudio();
    await start();
  }

  function dismissPause() {
    resumeContextRef.current = null;
    setPause(null);
  }

  const busy = starting || status === "connecting";
  const pauseCopy: Record<PauseReason, { title: string; body: string; cta: string }> = {
    background: {
      title: "Paused — the app went to the background",
      body: "iOS stops the microphone when this app isn't on screen, so the session was ended and your transcript saved. Pick up where you stopped whenever you're ready.",
      cta: "Resume session",
    },
    audio: {
      title: "Paused — the audio was interrupted",
      body: "A call, Siri or another app took the audio. Rather than sit here looking connected with a dead microphone, the session was ended and saved.",
      cta: "Restart session",
    },
    recovered: {
      title: "Your last session ended unexpectedly",
      body: "The transcript below was recovered and saved to this lesson's history. You can carry on from where it stopped.",
      cta: "Continue that session",
    },
  };

  return (
    <>
      <section className="panel">
        <h2>Practice</h2>
        <p className="muted">
          Press start and discuss the words out loud with the tutor. Interrupt any time.
        </p>
        {versions.length > 1 ? (
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "center",
              marginBottom: "0.5rem",
              // Version labels are long; let the row wrap on a phone rather than squeeze the picker.
              flexWrap: "wrap",
            }}
          >
            <span className="muted">Tutor version</span>
            <Select
              id="tutor-version"
              label="Tutor version"
              value={version}
              onValueChange={setVersion}
              options={versionOptions}
              disabled={connected || busy}
            />
          </div>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
          {connected ? (
            <Button onClick={() => endSession()}>End session</Button>
          ) : (
            <Button onClick={start} disabled={busy}>
              {busy ? "Connecting…" : "Start conversation"}
            </Button>
          )}
          <span className="muted">
            {connected
              ? isSpeaking
                ? "● teacher speaking — just talk to interrupt"
                : "● listening…"
              : `status: ${status}`}
          </span>
          {connected && keepAwake.method !== "none" ? (
            // A Popover, not a Tooltip: this explains something the learner can't infer, and
            // tooltips (native `title` included) never open on touch — which is most of this app's
            // use. Tapping the hint is what makes it reachable on a phone.
            <InfoPopover label="The screen is held awake for this session.">
              <span className="muted">☀ screen stays on</span>
            </InfoPopover>
          ) : null}
        </div>

        {/* The wake lock failed — say so, because the next auto-lock ends the session. */}
        {connected && keepAwake.reason ? (
          <p className="warn" style={{ marginBottom: 0 }}>
            {keepAwake.reason}
          </p>
        ) : null}

        {/* Running, but nothing has moved through the audio graph for a while. */}
        {connected && health === "stalled" ? (
          <p className="warn" style={{ marginBottom: 0 }}>
            No audio has moved in either direction for a while. If the tutor has gone quiet,{" "}
            <Button variant="inline" onClick={() => pauseRef.current("audio")}>
              restart the session
            </Button>
          </p>
        ) : null}

        {error ? (
          <p className="muted" style={{ color: "var(--error)" }}>
            {error}
          </p>
        ) : null}
      </section>

      {pause && !connected ? (
        <section className="panel" style={{ borderColor: "var(--warn)" }}>
          <h2 style={{ marginTop: 0 }}>{pauseCopy[pause].title}</h2>
          <p className="muted">{pauseCopy[pause].body}</p>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <Button onClick={resumeSession} disabled={busy}>
              {busy ? "Connecting…" : pauseCopy[pause].cta}
            </Button>
            <Button variant="quiet" onClick={dismissPause} disabled={busy}>
              Start fresh instead
            </Button>
          </div>
        </section>
      ) : null}

      {carried.length + lines.length > 0 ? (
        <section className="panel">
          <h2>Live transcript</h2>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {carried.concat(lines).map((l, i) => (
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
