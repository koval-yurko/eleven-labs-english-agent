import { useConversation } from "@elevenlabs/react-native";
import {
  API_V2_ROUTES,
  conversationTokenPath,
  isAgentVersionsResponse,
  isConversationTokenResponse,
  isLessonDetailResponse,
  lessonPath,
  type AgentVersionsResponse,
  type LessonDetailResponse,
  type TutorSessionInput,
} from "@tutor/shared/api";
import type { LessonItem, LessonSession } from "@tutor/shared/lesson-types";
import { buildAddItemsOp, MAX_ITEMS } from "@tutor/shared/sync-ops";
import { type Palette } from "@tutor/shared/theme";
import {
  formatItemsList,
  formatResumeContext,
  HIDDEN_KICKOFF_MESSAGES,
  KICKOFF_MESSAGE,
  PAUSE_RESUME_MESSAGE,
  RESUME_MESSAGE,
  type ResumeCause,
  type TranscriptLine,
} from "@tutor/shared/tutor";
import { useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useAuth0 } from "react-native-auth0";

import { apiFetch } from "@/api";
import { newId } from "@/lib/ids";
import { fetchLessonItems, postOp } from "@/lib/lessons";
import {
  clearJournal,
  clearPauseMarker,
  readJournal,
  readPauseMarker,
  writeJournal,
  writePauseMarker,
} from "@/lib/session-journal";
import { useTheme } from "@/theme";
import {
  Body,
  Button,
  ButtonRow,
  Disclosure,
  ErrorText,
  H1,
  Link,
  Muted,
  Panel,
  Screen,
  Select,
  TextField,
  space,
  type,
  useLoadingIndicator,
} from "@/ui";

/**
 * One lesson: its words, a live tutor session, and the history of past conversations.
 *
 * ## The session logic (unchanged)
 *
 * Ported from `apps/web/src/app/lessons/[id]/LessonTutor.tsx`, which stays exactly as it is: the
 * browser still needs the workarounds absent here. What survived is the part that was never about
 * the browser — the proactive kickoff, the hidden-message filter, the per-conversation-id save
 * guard, the carried transcript and the resume context. What went is everything that existed
 * because a web page cannot run a voice session in the background: the wake lock, the
 * volume-polling audio health check, the visibility grace timer, the `pagehide` beacons and the
 * `"background"` pause card. S1 measured that a locked native app keeps talking.
 *
 * `onDisconnect` carries `reason: "error" | "agent" | "user"`, so every inference the browser had
 * to make is replaced by reading a value. See docs/2026-08-13-expo-s4-tutor-screen.md §3.
 *
 * ## What the design port changed
 *
 * **This screen absorbed `/lessons/:id/words`.** Editing was its own screen (S5 D51) for two
 * reasons: the transcript wanted the viewport, and `items_list` is baked into `dynamicVariables` at
 * connect, so an inline editor "would advertise an immediacy that does not exist". The first reason
 * is gone — the page is one scroll container now, so nothing has to own the viewport. The second is
 * still true, and it is true on the web too, where both have always been on one page. The honest
 * fix is neither a second screen nor silence: the panel says so.
 *
 * **The History panel is new.** `LessonDetailResponse.sessions` has always carried past
 * conversations *with their transcripts*, and this screen has always fetched them — it rendered
 * `sessionCount` and discarded the rest. The web has shown them since the beginning.
 *
 * See docs/2026-08-15-web-design-parity-on-mobile.md §8.6.
 */

/**
 * Why the session is not running. Sourced from `onDisconnect`, never inferred.
 *
 * `reason: "user"` produces NO entry here on purpose: the learner pressed End and does not need to
 * be told what they just did. And there is no `"background"` — that failure cannot happen (S1).
 */
type PauseReason =
  | "paused" // the learner pressed Pause — the ONE entry here that is an intent, not an accident
  | "dropped" // reason: "error" — the connection failed (network, audio graph, LiveKit)
  | "ended" // reason: "agent" — the tutor or the server ended it (max_duration_seconds is 1800)
  | "recovered"; // a journal from a previous run was found at mount

const PAUSE_COPY: Record<PauseReason, { title: string; body: string; cta: string }> = {
  paused: {
    // No apology and no explanation of what happened: the learner did this on purpose and knows it.
    // What they cannot see is that the conversation was SAVED and the tutor will carry on, so that
    // is the only thing this says.
    title: "Paused",
    body: "The tutor is waiting. Everything said so far is saved — pick up where you stopped whenever you're ready.",
    cta: "Resume session",
  },
  dropped: {
    title: "The session dropped",
    body: "The connection to the tutor failed. What you had already said was saved — pick up where you stopped whenever you're ready.",
    cta: "Resume session",
  },
  ended: {
    // Not an apology: reaching the agent's 30-minute cap is the tutor hanging up politely.
    title: "The tutor ended the session",
    body: "That conversation is finished and saved. You can start another one with the same words — it will carry on from where this left off.",
    cta: "Continue practising",
  },
  recovered: {
    title: "Your last session ended unexpectedly",
    body: "The transcript below was recovered and saved to this lesson's history. You can carry on from where it stopped.",
    cta: "Continue that session",
  },
};

type ItemEvent = { at: string; kind: "added" | "removed"; text: string };

function formatDuration(secs: number | null): string | null {
  if (secs == null) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function LessonScreen() {
  const { id: lessonId } = useLocalSearchParams<{ id: string }>();
  const { getCredentials } = useAuth0();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const accessToken = useCallback(async () => {
    const credentials = await getCredentials();
    return credentials?.accessToken ?? null;
  }, [getCredentials]);

  // ── the lesson ─────────────────────────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<LessonDetailResponse | null>(null);
  const [versions, setVersions] = useState<AgentVersionsResponse | null>(null);
  const [items, setItems] = useState<LessonItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useLoadingIndicator(detail === null && loadError === null);

  /**
   * Three fetches, in parallel, on mount — and NOT the conversation token, which is minted at the
   * moment of connect (S3 D28): it lives 900 s and creates the conversation id with it, so fetching
   * it here would hand a stale one to a learner who read the word list first.
   *
   * `agent-versions` stays a separate call rather than a field on the lesson: it is not lesson data,
   * it changes on deploy rather than on edit, and folding it in would make every lesson read depend
   * on the agent registry.
   *
   * The items call is the third, and it is the one this screen gained with the merge. It returns
   * every item row INCLUDING removed ones, so the editable list is `removed_at === null` and the
   * change log is the same array flat-mapped into events — exactly how the web's page derives both
   * from its one `listLessonItemHistory` query. It is also the only route that carries item **ids**,
   * and `remove` needs one: `LessonDetail.items` is `string[]` (D44).
   */
  const load = useCallback(async () => {
    try {
      const [lesson, agents, itemRows] = await Promise.all([
        apiFetch<unknown>(lessonPath(lessonId), accessToken),
        apiFetch<unknown>(API_V2_ROUTES.agentVersions, accessToken),
        fetchLessonItems(accessToken, lessonId),
      ]);
      if (!isLessonDetailResponse(lesson)) throw new Error("Malformed lesson response.");
      setDetail(lesson);
      setItems(itemRows);
      if (isAgentVersionsResponse(agents)) setVersions(agents);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [accessToken, lessonId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // ── the words ──────────────────────────────────────────────────────────────────────────────
  const [itemsBusy, setItemsBusy] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /**
   * What a failed write left behind: the optimistic state it wanted and the op that would produce
   * it. The ARGUMENTS rather than a closure over `writeItems`, because they are exactly what a
   * durable outbox would store when the mirror lands.
   */
  const retryRef = useRef<{ next: LessonItem[]; run: () => Promise<void> } | null>(null);

  /** Active rows in display order — what the learner edits, and what the tutor will be given. */
  const active = useMemo(
    () =>
      (items ?? []).filter((i) => i.removed_at === null).sort((a, b) => a.position - b.position),
    [items],
  );

  /** Each row is an "added" event, and a removed one is also a "removed" event. Newest first. */
  const events = useMemo<ItemEvent[]>(
    () =>
      (items ?? [])
        .flatMap((it) => {
          const evs: ItemEvent[] = [{ at: it.created_at, kind: "added", text: it.text }];
          if (it.removed_at) evs.push({ at: it.removed_at, kind: "removed", text: it.text });
          return evs;
        })
        .sort((a, b) => (a.at < b.at ? 1 : -1)),
    [items],
  );

  /** Optimistic apply, then re-read; snapshot back on failure and keep the op for a retry (§3.2). */
  const writeItems = useCallback(
    async (next: LessonItem[], run: () => Promise<void>) => {
      if (itemsBusy) return;
      const snapshot = items;
      setItemsBusy(true);
      setItemsError(null);
      setItems(next);
      try {
        await run();
        retryRef.current = null;
        await load();
      } catch (e) {
        setItems(snapshot);
        retryRef.current = { next, run };
        setItemsError(e instanceof Error ? e.message : String(e));
      } finally {
        setItemsBusy(false);
      }
    },
    [itemsBusy, items, load],
  );

  const room = Math.max(0, MAX_ITEMS - active.length);
  const atCap = room === 0;

  async function addItems() {
    if (!items) return;
    const texts = draft
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, room);
    // `buildAddItemsOp` owns the whole rule: normalize, drop blanks, drop anything already active or
    // repeated in the batch, and number what survives from `max(position) + 1` — a removed item
    // leaves a gap and reusing its position would collide.
    const op = buildAddItemsOp(lessonId, texts, active, newId);
    if (!op) {
      // Every line was blank or already here. Clearing the box IS the feedback; inventing an error
      // for "you already have that word" would be noise.
      setDraft("");
      return;
    }

    const at = new Date().toISOString();
    const optimistic: LessonItem[] = op.items.map((it) => ({
      id: it.id,
      text: it.text,
      position: it.position,
      created_at: at,
      removed_at: null,
    }));
    setDraft("");
    await writeItems([...items, ...optimistic], () => postOp(accessToken, op));
  }

  async function removeItem(item: LessonItem) {
    if (!items) return;
    const at = new Date().toISOString();
    // Marked removed rather than dropped: the row IS the history, so the change log updates with it.
    const next = items.map((i) => (i.id === item.id ? { ...i, removed_at: at } : i));
    await writeItems(next, () =>
      postOp(accessToken, { kind: "removeItem", lessonId, itemId: item.id }),
    );
  }

  // ── the session ────────────────────────────────────────────────────────────────────────────
  const [version, setVersion] = useState<string | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  // Turns from earlier, interrupted conversations of the same sitting. Kept out of `lines` so each
  // conversation is saved under its own id and nothing is stored twice; shown together below.
  const [carried, setCarried] = useState<TranscriptLine[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pause, setPause] = useState<PauseReason | null>(null);

  // Mirrors for the SDK callbacks (they close over the render they were created in).
  const linesRef = useRef<TranscriptLine[]>([]);
  const versionRef = useRef("");
  /** THE ROW KEY. Seeded from the token response before `startSession`, never by a callback (S3 D23). */
  const conversationIdRef = useRef<string | null>(null);
  const savedForRef = useRef<string | null>(null);
  /**
   * What the next session will be handed, and WHY it is being handed it. One ref rather than a pair,
   * because a cause that can drift out of sync with its lines is a cause that eventually describes
   * the wrong conversation — and this value is spoken aloud by the tutor.
   */
  const resumeContextRef = useRef<{ lines: TranscriptLine[]; cause: ResumeCause } | null>(null);
  /**
   * Set by `pauseSession` and read once by `onDisconnect`. The SDK reports `reason: "user"` for
   * BOTH buttons — End and Pause hang up identically — so intent cannot be inferred from the
   * transport and has to be recorded here, on the way out.
   */
  const pauseIntentRef = useRef(false);
  const kickedOffRef = useRef(false);
  const statusRef = useRef<string>("disconnected");

  const selectedVersion = version ?? versions?.defaultVersion ?? null;

  /** The journal payload for whatever is being said right now. */
  const snapshot = useCallback(
    () => ({
      lessonId,
      conversationId: conversationIdRef.current,
      agentVersion: versionRef.current,
      lines: linesRef.current,
    }),
    [lessonId],
  );

  /**
   * Persist the finished conversation once per conversation id, then refresh the history below.
   * Best-effort: a failed save must not break the UI — the post-call webhook is the backstop and the
   * journal keeps the local copy either way.
   */
  const persistSession = useCallback(async () => {
    const conversationId = conversationIdRef.current;
    if (!conversationId || savedForRef.current === conversationId) return;
    if (linesRef.current.length === 0) return;
    savedForRef.current = conversationId;

    const payload: TutorSessionInput = {
      lessonId,
      conversationId,
      agentVersion: versionRef.current,
      lines: linesRef.current,
    };
    try {
      await apiFetch(API_V2_ROUTES.lessonSession, accessToken, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await clearJournal(lessonId);
      void load(); // the web called router.refresh(); here the history is refetched
    } catch {
      // Un-guard so a later attempt can retry: a lost transcript is the one failure that cannot be
      // recovered after the fact.
      savedForRef.current = null;
    }
  }, [accessToken, lessonId, load]);

  const conversation = useConversation({
    onConnect: ({ conversationId: sdkId }) => {
      // ADVISORY ONLY — compared, never written to the ref. The SDK derives this from the LiveKit
      // room name and falls back to `room_<timestamp>` when that name is empty, which no other
      // writer would ever produce. S3 measured them agreeing; this is the tripwire for the day they
      // stop.
      const authoritative = conversationIdRef.current;
      if (authoritative && sdkId !== authoritative) {
        setError(`Session id mismatch (${sdkId}). The transcript is still saved correctly.`);
      }
    },
    onMessage: ({ message, role }) => {
      // The kickoff is the trigger, not something the learner said — every other writer filters it
      // out of the stored history, so it must not be collected here either.
      if (role === "user" && HIDDEN_KICKOFF_MESSAGES.includes(message)) return;
      linesRef.current = [...linesRef.current, { role, text: message }];
      setLines(linesRef.current);
      // Journal as we go: a crash or a force-quit never runs `onDisconnect`.
      void writeJournal(snapshot());
    },
    /**
     * Barge-in. Without this the record claims the teacher finished sentences the learner cut off —
     * in an app whose whole premise is interrupting freely. The web app has never wired it and
     * mostly gets away with it because the post-call webhook overwrites the row with ElevenLabs'
     * corrected copy; "mostly" is the problem, since a webhook that fails leaves the wrong text
     * permanent.
     */
    onAgentResponseCorrection: ({ original_agent_response, corrected_agent_response }) => {
      const index = linesRef.current.findLastIndex(
        (l) => l.role === "agent" && l.text === original_agent_response,
      );
      if (index === -1) return;
      const corrected = [...linesRef.current];
      corrected[index] = { role: "agent", text: corrected_agent_response };
      linesRef.current = corrected;
      setLines(corrected);
      void writeJournal(snapshot());
    },
    onStatusChange: ({ status: next }) => {
      statusRef.current = next;
    },
    onDisconnect: (details) => {
      kickedOffRef.current = false;
      const intended = pauseIntentRef.current;
      pauseIntentRef.current = false;
      void persistSession();
      // The whole pause machine: the SDK says why, so nothing is inferred — except the one thing it
      // cannot say, which is whether the learner meant to stop. A deliberate pause wins over the
      // transport's own reason, so a connection that dies in the half-second after the tap still
      // reads as "Paused" rather than "The session dropped".
      if (intended) setPause("paused");
      else if (details.reason === "error") setPause("dropped");
      else if (details.reason === "agent") setPause("ended");
      // "user" without intent — the learner pressed End and knows it. No card.
      if ((intended || details.reason !== "user") && linesRef.current.length > 0) {
        resumeContextRef.current = {
          lines: linesRef.current,
          cause: intended ? "paused" : "interrupted",
        };
        // Parked on the device so the pause outlives this screen and this process. Written for a
        // PAUSE only: an accident is already covered by the journal, which is still on disk if the
        // save above fails and is cleared if it succeeds.
        if (intended) {
          void writePauseMarker({
            lessonId,
            conversationId: conversationIdRef.current,
            agentVersion: versionRef.current,
            lines: linesRef.current,
          });
        }
      }
    },
    // The SDK triggers the OS microphone prompt itself from `AudioSession.configureAudio()`, so
    // there is no pre-flight permission call and a DENIED microphone arrives here.
    onError: (message) =>
      setError(`${message} — if you haven't allowed the microphone yet, that looks like this too.`),
  });

  const { status, startSession, endSession, sendUserMessage, sendContextualUpdate } = conversation;
  const connected = status === "connected";
  const busy = starting || status === "connecting";

  /**
   * Proactive kickoff: `first_message` is empty, so the instant we connect we send a hidden user
   * message — that reliably makes the agent take its opening turn without the learner speaking
   * first. A resumed session gets the interrupted conversation as context first, so it continues
   * instead of starting the lesson over.
   *
   * Keyed on `status` and it must stay that way: `WebRTCConnection.sendMessage` drops anything sent
   * before `RoomEvent.Connected` with a console warning and no error.
   */
  useEffect(() => {
    if (status !== "connected" || kickedOffRef.current) return;
    kickedOffRef.current = true;
    const resumeFrom = resumeContextRef.current;
    resumeContextRef.current = null;
    if (resumeFrom && resumeFrom.lines.length > 0) {
      sendContextualUpdate(formatResumeContext(resumeFrom.lines, resumeFrom.cause));
      sendUserMessage(resumeFrom.cause === "paused" ? PAUSE_RESUME_MESSAGE : RESUME_MESSAGE);
    } else {
      sendUserMessage(KICKOFF_MESSAGE);
    }
  }, [status, sendUserMessage, sendContextualUpdate]);

  /**
   * A tutor session may not outlive the screen that owns it.
   *
   * `ConversationProvider` is mounted in `_layout.tsx`, ABOVE the router — so unmounting this screen
   * does not touch the conversation — and `UIBackgroundModes: ["audio"]` means iOS will not suspend
   * the app either. Without this, navigating back mid-session leaves a live, billed, listening
   * session running with nothing on screen saying so. The web cannot have this bug; leaving the page
   * tears the whole runtime down.
   *
   * Persist BEFORE ending: `endSession` reaches `persistSession` through `onDisconnect`, but this
   * component is unmounting and that callback may not survive to finish a network call. The
   * per-conversation guard makes the second attempt a no-op.
   *
   * The dependency array is EMPTY and the callbacks are reached through a ref, deliberately. Listing
   * `persistSession` would re-run this effect — and therefore its cleanup — every time that callback
   * changed identity, which is every time `load` does: the guard would end the lesson mid-sentence
   * instead of on unmount. "Runs once, reads the latest" is the whole requirement.
   */
  const latest = useRef({ persistSession, endSession });
  useEffect(() => {
    latest.current = { persistSession, endSession };
  });
  useEffect(
    () => () => {
      if (statusRef.current === "connected") {
        void latest.current.persistSession();
        latest.current.endSession();
      }
    },
    [],
  );

  /**
   * Two things can be waiting on disk at mount, and they are checked in this order:
   *
   *   1. **A journal** — the last session died without saving: a crash or a force-quit, since
   *      backgrounding is survivable here. Push it to the server, then offer to carry on.
   *   2. **A pause marker** — the learner pressed Pause and then left (or the app restarted). The
   *      transcript was already saved on the way out, so there is nothing to push; the marker only
   *      restores the card and the context.
   *
   * The journal wins when both exist, because both existing means the save at pause time FAILED —
   * so the unsaved copy is the one that has to reach the server, and the marker would only put a
   * second card on the same screen. Its copy ("ended unexpectedly") is then also the true one.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const journal = await readJournal(lessonId);
      if (cancelled) return;
      if (!journal || journal.lines.length === 0) {
        const marker = await readPauseMarker(lessonId);
        if (cancelled || !marker || marker.lines.length === 0) return;
        setCarried(marker.lines);
        resumeContextRef.current = { lines: marker.lines, cause: "paused" };
        setPause("paused");
        return;
      }
      await clearPauseMarker(lessonId);
      if (journal.conversationId) {
        try {
          await apiFetch(API_V2_ROUTES.lessonSession, accessToken, {
            method: "POST",
            body: JSON.stringify({
              lessonId,
              conversationId: journal.conversationId,
              agentVersion: journal.agentVersion,
              lines: journal.lines,
            } satisfies TutorSessionInput),
          });
          void load();
        } catch {
          // The post-call webhook is the backstop; the lines are still offered as context below.
        }
      }
      await clearJournal(lessonId);
      if (cancelled) return;
      setCarried(journal.lines);
      resumeContextRef.current = { lines: journal.lines, cause: "interrupted" };
      setPause("recovered");
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, lessonId, load]);

  async function start() {
    if (!detail || connected || busy) return;
    setError(null);
    setStarting(true);
    try {
      // No microphone pre-flight: the SDK's audio session raises the prompt itself, so a denial
      // arrives through `onError` rather than here.
      const res = await apiFetch<unknown>(
        conversationTokenPath(selectedVersion ?? undefined),
        accessToken,
        { method: "POST" },
      );
      if (!isConversationTokenResponse(res)) {
        throw new Error("The server did not return a usable conversation token.");
      }

      const resuming = (resumeContextRef.current?.lines.length ?? 0) > 0;
      // Either way the next conversation starts with a transcript of its own; resuming moves what
      // was already said into the read-only carried block above it.
      setCarried(resuming ? (prev) => [...prev, ...linesRef.current] : []);
      setLines([]);
      linesRef.current = [];
      await clearJournal(lessonId);
      // The pause is being spent — whether it is resumed or overridden by a fresh start, the parked
      // copy must not outlive this call, or the next mount offers a resume into a conversation the
      // learner has already moved past.
      await clearPauseMarker(lessonId);
      savedForRef.current = null;
      kickedOffRef.current = false;
      setPause(null);

      // Seeded BEFORE startSession. From here on this is the row key, whatever the transport says.
      conversationIdRef.current = res.conversationId;
      versionRef.current = res.version;
      setVersion(res.version);

      startSession({
        conversationToken: res.token,
        connectionType: "webrtc", // the only transport the RN SDK supports; websocket throws
        // The screen is never held awake (D40): S1 proved a locked session keeps talking, and the
        // web's wake lock was an apology for a browser limitation that does not exist here.
        useWakeLock: false,
        dynamicVariables: {
          items_list: formatItemsList(detail.lesson.itemsDetailed),
          // Ties the post-call webhook payload back to this lesson's history.
          lesson_id: lessonId,
          // Required, never defaulted: the webhook routes on it, and a missing one would file this
          // session under the wrong environment.
          app_env: res.appEnv,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  /**
   * Pause = hang up with intent. There is no pause on the platform (a conversation is open or it is
   * over, and an ended one cannot be reopened), so the tap ends the session and `onDisconnect` does
   * the rest: save, arm the resume context, park the marker, show the card. Resuming is `start()`
   * unchanged — the same path a dropped session already takes.
   *
   * Holding the line open instead (mute the mic and heartbeat `user_activity` so the tutor stays
   * quiet) is the intended follow-up and would make a short pause resume instantly; it is not this
   * change. See docs/2026-08-16-tutor-session-pause-resume.md §4.1.
   */
  function pauseSession() {
    if (!connected) return;
    pauseIntentRef.current = true;
    endSession();
  }

  function dismissPause() {
    resumeContextRef.current = null;
    setPause(null);
    void clearPauseMarker(lessonId);
  }

  // ── render ─────────────────────────────────────────────────────────────────────────────────
  const transcript = useMemo(() => carried.concat(lines), [carried, lines]);
  /**
   * One line, three states. A paused session is `disconnected` at the transport, so reporting the
   * raw status there would say "status: disconnected" to someone looking at a Resume button.
   */
  const statusLine = connected
    ? "● listening — just talk to interrupt"
    : pause === "paused"
      ? "⏸ paused — resume when you're ready"
      : `status: ${status}`;
  const versionOptions = useMemo(
    () => (versions?.versions ?? []).map((v) => ({ value: v.version, label: v.label })),
    [versions],
  );

  if (loadError) {
    return (
      <Screen>
        <Muted>
          <Link href="/lessons">← all lessons</Link>
        </Muted>
        <Panel tone="error">
          <ErrorText>{loadError}</ErrorText>
          <ButtonRow style={{ marginTop: space.row }}>
            <Button variant="secondary" label="Try again" onPress={() => void load()} />
          </ButtonRow>
        </Panel>
      </Screen>
    );
  }

  if (!detail) {
    return (
      <Screen>
        <Muted>
          <Link href="/lessons">← all lessons</Link>
        </Muted>
        <ActivityIndicator color={theme.accent} style={{ marginTop: 24 }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <H1>{detail.lesson.title}</H1>
      <Muted>
        Created {new Date(detail.lesson.created_at).toLocaleDateString()} ·{" "}
        <Link href="/lessons">← all lessons</Link>
      </Muted>

      {/* ── Words ──────────────────────────────────────────────────────────────────────────── */}
      <Panel title="Words in this lesson">
        {items === null ? (
          <ActivityIndicator color={theme.accent} />
        ) : active.length === 0 ? (
          <Muted>No words yet — add some below.</Muted>
        ) : (
          active.map((item) => (
            <View key={item.id} style={styles.wordRow}>
              <Body style={{ flex: 1 }}>{item.text}</Body>
              <Button
                variant="inline"
                tone="danger"
                label="remove"
                disabled={itemsBusy}
                onPress={() => void removeItem(item)}
                accessibilityLabel={`Remove ${item.text}`}
              />
            </View>
          ))
        )}

        <TextField
          value={draft}
          onChangeText={setDraft}
          multiline
          editable={!atCap}
          placeholder="Add words or sentences — one per line"
          accessibilityLabel="Words or sentences to add — one per line"
          style={{ marginTop: space.panelGap }}
        />
        <ButtonRow style={{ marginTop: space.row }}>
          <Button
            label="Add words"
            disabled={atCap || itemsBusy}
            onPress={() => void addItems()}
          />
          <Muted>
            {atCap ? `Lesson is full (${MAX_ITEMS} items).` : `${active.length}/${MAX_ITEMS} items`}
          </Muted>
        </ButtonRow>

        {/* The caveat that made editing its own screen (D51). It is true on the web too, which has
            simply never said it — `items_list` is baked into `dynamicVariables` at connect. */}
        <Muted style={{ marginTop: space.row }}>Changes apply to your next conversation.</Muted>

        {itemsError ? (
          <>
            <ErrorText style={{ marginTop: space.row }}>{itemsError}</ErrorText>
            <ButtonRow style={{ marginTop: space.row }}>
              <Button
                variant="secondary"
                label="Retry"
                disabled={itemsBusy}
                onPress={() => {
                  const again = retryRef.current;
                  if (again) void writeItems(again.next, again.run);
                }}
              />
            </ButtonRow>
          </>
        ) : null}
      </Panel>

      {/* ── Practice ───────────────────────────────────────────────────────────────────────── */}
      <Panel title="Practice">
        <Muted>Press start and discuss the words out loud with the tutor. Interrupt any time.</Muted>

        {versionOptions.length > 1 ? (
          <View style={styles.versionRow}>
            <Muted>Tutor version</Muted>
            <Select
              label="Tutor version"
              value={selectedVersion ?? versionOptions[0]?.value ?? ""}
              onValueChange={setVersion}
              options={versionOptions}
              disabled={connected || busy}
            />
          </View>
        ) : null}

        {/* Two slots, always in the same place: the session verb on the left, the pause verb on
            the right. The right slot is empty when there is nothing to pause and nothing paused —
            a disabled button there would advertise a control the learner cannot reach yet. */}
        <ButtonRow style={{ marginTop: space.row }}>
          {connected ? (
            <Button label="End session" onPress={() => endSession()} />
          ) : (
            <Button
              label={busy ? "Connecting…" : "Start conversation"}
              disabled={busy}
              onPress={() => void start()}
            />
          )}
          {connected ? (
            <Button variant="secondary" label="Pause" onPress={pauseSession} />
          ) : pause === "paused" ? (
            <Button
              variant="secondary"
              label="Resume"
              disabled={busy}
              onPress={() => void start()}
            />
          ) : null}
        </ButtonRow>

        {/* Its own line, below the buttons. It used to sit beside them, where a two-button row
            leaves it no width and it wraps under half a button anyway. */}
        <Muted style={{ marginTop: space.row }}>{statusLine}</Muted>

        {error ? <ErrorText style={{ marginTop: space.row }}>{error}</ErrorText> : null}
      </Panel>

      {/* `warn` for the three accidents, plain for the one intent: a bordered alert around "Paused"
          would dress the learner's own decision up as something that went wrong. */}
      {pause && !connected ? (
        <Panel tone={pause === "paused" ? undefined : "warn"} title={PAUSE_COPY[pause].title}>
          <Muted>{PAUSE_COPY[pause].body}</Muted>
          <ButtonRow style={{ marginTop: space.row }}>
            <Button
              label={busy ? "Connecting…" : PAUSE_COPY[pause].cta}
              disabled={busy}
              onPress={() => void start()}
            />
            <Button
              variant="quiet"
              label="Start fresh instead"
              disabled={busy}
              onPress={dismissPause}
            />
          </ButtonRow>
        </Panel>
      ) : null}

      {/* ── Live transcript ────────────────────────────────────────────────────────────────── */}
      {transcript.length > 0 ? (
        <Panel title="Live transcript">
          {transcript.map((line, i) => (
            <Line key={i} line={line} />
          ))}
        </Panel>
      ) : null}

      {/* ── Word changes ───────────────────────────────────────────────────────────────────── */}
      {events.length > 0 ? (
        <Panel>
          <Disclosure
            summary={
              <Body>
                <Text style={styles.strong}>Word changes</Text>{" "}
                <Text style={styles.muted}>
                  — {events.length} {events.length === 1 ? "event" : "events"}
                </Text>
              </Body>
            }
          >
            {events.map((e, i) => (
              <Body key={i} style={styles.logLine}>
                <Text style={e.kind === "added" ? styles.added : styles.removed}>
                  {e.kind === "added" ? "＋ added" : "－ removed"}
                </Text>{" "}
                <Text style={styles.strong}>{e.text}</Text>{" "}
                <Text style={styles.muted}>— {new Date(e.at).toLocaleString()}</Text>
              </Body>
            ))}
          </Disclosure>
        </Panel>
      ) : null}

      {/* ── History ────────────────────────────────────────────────────────────────────────── */}
      <Panel title="History">
        {detail.sessions.length === 0 ? (
          <Muted>No conversations yet — start one above and it will appear here.</Muted>
        ) : (
          <>
            {/* A cap the client cannot see is a cap that lies (`MAX_LESSON_SESSIONS`). */}
            {detail.sessionCount > detail.sessions.length ? (
              <Muted style={{ marginBottom: space.row }}>
                Showing {detail.sessions.length} of {detail.sessionCount} conversations.
              </Muted>
            ) : null}
            {detail.sessions.map((session) => (
              <SessionEntry key={session.id} session={session} />
            ))}
          </>
        )}
      </Panel>
    </Screen>
  );
}

function SessionEntry({ session }: { session: LessonSession }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const meta = [
    new Date(session.created_at).toLocaleString(),
    session.agent_version,
    formatDuration(session.duration_secs),
    `${session.transcript.length} turns`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Disclosure
      style={styles.sessionRow}
      summary={
        <Body>
          <Text style={styles.strong}>Conversation</Text>{" "}
          <Text style={styles.muted}>— {meta}</Text>
        </Body>
      }
    >
      {session.summary ? <Muted style={styles.summary}>{session.summary}</Muted> : null}
      {session.transcript.map((line, i) => (
        <Line key={i} line={line} />
      ))}
    </Disclosure>
  );
}

/**
 * One transcript turn. Memoised because every live line re-renders this screen — the combined
 * `useConversation` hook is deliberately kept for the port (D37), and splitting its hooks is an
 * optimisation to make with a measurement.
 */
const Line = memo(function Line({ line }: { line: TranscriptLine }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Body style={styles.line}>
      <Text style={line.role === "agent" ? styles.agent : styles.you}>
        {line.role === "agent" ? "Teacher" : "You"}:{" "}
      </Text>
      <Text style={styles.muted}>{line.text}</Text>
    </Body>
  );
});

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wordRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 0.75 * 16,
      paddingVertical: 0.25 * 16,
    },
    versionRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: space.row,
      marginTop: space.row,
    },
    line: { marginBottom: space.row },
    agent: { color: t.accent, fontWeight: type.weightBold },
    you: { color: t.ok, fontWeight: type.weightBold },
    muted: { ...type.small, color: t.muted },
    strong: { fontWeight: type.weightBold },
    logLine: { marginBottom: 0.35 * 16 },
    added: { color: t.ok },
    removed: { color: t.error },
    sessionRow: { borderBottomWidth: 1, borderBottomColor: t.border },
    summary: { fontStyle: "italic", marginBottom: space.row },
  });
