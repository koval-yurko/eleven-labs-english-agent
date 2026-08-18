import { useConversation, useRawConversation } from "@elevenlabs/react-native";
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
  ABORTED_RESUME_MESSAGE,
  formatHeldResumeContext,
  formatItemsList,
  formatResumeContext,
  HIDDEN_KICKOFF_MESSAGES,
  KICKOFF_MESSAGE,
  PAUSE_CONTEXT,
  PAUSE_RESUME_MESSAGE,
  PAUSE_STOP_MESSAGE,
  RESUME_MESSAGE,
  TUTOR_HEARTBEAT_MS,
  UNHEARD_RESUME_MESSAGE,
  type ResumeCause,
  type TranscriptLine,
} from "@tutor/shared/tutor";
import * as Linking from "expo-linking";
import { useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { useAuth0 } from "react-native-auth0";

import {
  addControlIntentListener,
  drainControlIntents,
  endActivity,
  isActivityAvailable,
  startActivity,
  updateActivity,
  type ActivityState,
} from "@/modules/lesson-activity";

import { apiFetch } from "@/api";
import { setAgentAudioVolume } from "@/lib/agent-audio";
import {
  buildActivityState,
  END_CONFIRM_MS,
  nextArmedAt,
  OVER_CARD_LINGER_MS,
  resolveIntents,
  sameActivityState,
} from "@/lib/lesson-activity-state";
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

/**
 * How often a held pause pings `user_activity` — see `TUTOR_HEARTBEAT_MS` for the reasoning.
 *
 * It moved into `packages/shared` when words-1.5 took `turn_timeout` to 3 s for podcast pacing:
 * the ping interval and the baked timeout are one mechanism, and a local constant reasoning about
 * a 7-second window went stale the moment the window changed on the server.
 *
 * The ping itself can never report failure — `WebRTCConnection.sendMessage` warns and returns when
 * the room is gone, and swallows publish errors — so liveness is read from `status`, never from
 * this. See docs/2026-08-18-podcast-mode-tutor.md §3.
 */
const HEARTBEAT_MS = TUTOR_HEARTBEAT_MS;

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
   * "This session is being hung up while the learner considered it PAUSED" — read once by
   * `onDisconnect`, which then parks it instead of treating it as an ordinary End.
   *
   * The Pause button no longer sets this: it holds the line open and never disconnects. What does
   * set it is the unmount guard, because navigating away from a held pause has to end the call (a
   * live, billed, listening session with nothing on screen saying so is the bug that guard exists to
   * prevent) and the learner should still find their lesson waiting when they come back. The SDK
   * reports `reason: "user"` for that teardown exactly as it does for End, so the intent cannot be
   * read off the transport and is recorded here on the way out.
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

  const {
    status,
    isMuted,
    isSpeaking,
    startSession,
    endSession,
    sendUserMessage,
    sendContextualUpdate,
    sendUserActivity,
    setMuted,
  } = conversation;
  /**
   * The escape hatch, for exactly one job: silencing the tutor. `conversation.setVolume()` is a
   * NO-OP on React Native — the SDK only registers an audio adapter in its web entrypoint — so a
   * pause that called it left the tutor audible. See `@/lib/agent-audio`.
   */
  const rawConversation = useRawConversation();
  const connected = status === "connected";
  const busy = starting || status === "connecting";

  // ── the held pause ─────────────────────────────────────────────────────────────────────────
  /**
   * Pause WITHOUT hanging up: mute the microphone, silence the output, and keep the turn timer from
   * expiring with a `user_activity` heartbeat. The conversation stays open, so the tutor keeps its
   * own context and there is nothing to hand over on the way back — which is the entire point. The
   * shipped alternative (end the session, replay the tail into a new one) is structurally lossy: the
   * system prompt comes back in full telling the agent to greet and teach item one, and it wins the
   * argument against a truncated chat log delivered as background information. That is the
   * repetition. See docs/2026-08-16-tutor-pause-hold-the-line.md §1.
   *
   * `endSession` is NOT part of this path. It stays behind the End button, and behind the unmount
   * guard, where hanging up is what the learner actually asked for.
   */
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heldSinceRef = useRef<number>(0);
  /**
   * Where the transcript stood when the hold began, so a resume can tell whether a WHOLE turn
   * played into the void while the line was held — one that slipped past the heartbeat.
   *
   * It no longer has to catch the turn that was in flight at the tap: `abortedRef` below owns that
   * case, and owns it more accurately. The mark alone was timing-dependent — `agent_response`
   * carries the full text as soon as the LLM finishes, typically well BEFORE the audio has finished
   * playing, so the line of a turn the learner was cut off in has usually already landed and does
   * not count as "added since the mark". Two cases, two signals.
   */
  const heldAtLineRef = useRef(0);
  /**
   * Was the tutor mid-sentence when Pause landed — i.e. did we barge in to stop it?
   *
   * This is what decides which resume message is owed, and the two are different requests: a turn
   * we cut off owes the learner the TAIL of one thought (the tutor's own context now ends where
   * the learner stopped hearing it, because `agent_response_correction` truncated it); a turn that
   * played out unheard owes them THAT POINT restated. Both are bounded — which is the whole fix.
   * The single unbounded "recap what I missed" they replace is what re-delivered a whole item.
   * See docs/2026-08-17-short-turns-and-chunked-pause.md §4.3.
   */
  const abortedRef = useRef(false);
  /**
   * `isSpeaking`, readable from outside a render — the hold path runs from a lock-screen intent
   * drain as well as from a button, and both need the value as it is NOW. Same idiom as `mutedRef`.
   */
  const speakingRef = useRef(false);
  useEffect(() => {
    speakingRef.current = isSpeaking;
  });
  /** Did we actually manage to silence the agent's audio? `false` is shown, never hidden. */
  const [silenced, setSilenced] = useState(true);
  /**
   * Standalone mute — "keep teaching, I just need to not be recorded for a moment".
   *
   * NOT the same control as Pause, even though Pause mutes: a pause silences BOTH directions and
   * runs the heartbeat that keeps `turn_timeout` from firing, so the tutor waits. A mute silences
   * only the microphone and has no heartbeat, deliberately — so a mute held past ~7 s gets a tutor
   * asking whether the learner is still there, which is the correct behaviour for "I can hear you,
   * carry on". See docs/2026-08-16-background-controls-lock-screen.md §3.4.
   *
   * The mute bit itself is NOT stored here. `useConversation` already owns it — `isMuted` is the
   * provider's own state, and its `onDisconnect` resets it to `false` `[source]`. Mirroring it in a
   * `useState` gave the same bit two homes and one of them would eventually be wrong; the ref below
   * exists only because two readers are outside a render (the hold path and the lock-screen intent
   * drain, which resolves a tap against the state as it is *now*).
   */
  const mutedRef = useRef(false);
  useEffect(() => {
    mutedRef.current = isMuted;
  });
  /**
   * The learner's OWN mute, remembered across a pause.
   *
   * Pause mutes as part of holding the line, so without this a resume would unmute someone who had
   * muted on purpose before pausing. `releaseSession` restores this rather than assuming `false` —
   * which was safe only while Pause was the sole writer of the mute bit. §3.3 of the same document.
   */
  const wasMutedRef = useRef(false);
  /**
   * The armed End confirm, as a timestamp.
   *
   * A lock screen has no alerts, sheets or modals, so the strongest confirmation End can express is
   * relabelling itself and waiting for a second tap. This is the only non-idempotent control on the
   * card, and the only one that does not fire on first press. See
   * docs/2026-08-16-background-controls-lock-screen.md §3.5.
   */
  const endArmedAtRef = useRef<number | null>(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current !== null) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  function holdSession() {
    if (!connected || heldRef.current) return;
    // Output first, then the microphone: both are instant, and between them they are the whole of
    // what the learner can perceive.
    //
    // Through LiveKit, NOT through `conversation.setVolume()`, which is a silent no-op on React
    // Native and left the tutor audible through the whole of the first held pause. The return value
    // is how many agent tracks were actually reached; 0 means the escape hatch is closed, and the
    // status line says so rather than claiming a silence we did not deliver (`@/lib/agent-audio`).
    setSilenced(setAgentAudioVolume(rawConversation, 0) > 0);
    // Remembered before the pause takes the microphone, so a resume gives the learner back the
    // mute they chose rather than the one the pause imposed. §3.3.
    wasMutedRef.current = mutedRef.current;
    setMuted(true);
    mutedRef.current = true;
    heldAtLineRef.current = linesRef.current.length;
    heldSinceRef.current = Date.now();
    // The barge-in. Silencing the speaker is local — the platform has no idea, so without this the
    // tutor keeps teaching to nobody for the rest of its turn, is billed for it, and comes back
    // convinced the learner heard it. `user_message` is the only client event that ends a turn
    // ("triggers the same response flow as spoken user input"); there is no abort in the protocol.
    // Guarded on `isSpeaking` because a pause taken while the tutor is LISTENING has nothing to
    // interrupt, and barging into silence would only provoke a turn.
    abortedRef.current = speakingRef.current;
    if (abortedRef.current) sendUserMessage(PAUSE_STOP_MESSAGE);
    sendContextualUpdate(PAUSE_CONTEXT);
    heartbeatRef.current = setInterval(() => sendUserActivity(), HEARTBEAT_MS);
    heldRef.current = true;
    setHeld(true);
  }

  function releaseSession() {
    if (!heldRef.current) return;
    stopHeartbeat();
    heldRef.current = false;
    setHeld(false);
    // The line died while the pause was held: `setMuted` THROWS with no active conversation, and
    // the provider has already reset its own mute state on disconnect. The drop path owns this.
    if (!connected) return;
    // Restore, do NOT assume: the learner may have muted themselves before pausing, and a pause is
    // not a request to be unmuted. See §3.3 of the background-controls document.
    setMuted(wasMutedRef.current);
    mutedRef.current = wasMutedRef.current;
    setAgentAudioVolume(rawConversation, 1);
    setSilenced(true);
    sendContextualUpdate(formatHeldResumeContext((Date.now() - heldSinceRef.current) / 1000));
    // What the learner is owed, in exactly three cases — and each of the two that speak is bounded
    // to ONE turn, which with words-1.4 is one thread of one item. The tutor was:
    //   listening → nothing was lost; say nothing and let the learner speak first
    //   cut off   → the tail of one thought
    //   unheard   → one whole turn, restated
    // The order matters: an aborted turn is also a turn that landed after the mark on some timings,
    // and asking for the tail is the smaller, more accurate request of the two.
    const aborted = abortedRef.current;
    abortedRef.current = false;
    if (aborted) {
      sendUserMessage(ABORTED_RESUME_MESSAGE);
      return;
    }
    const unheard = linesRef.current
      .slice(heldAtLineRef.current)
      .some((line) => line.role === "agent");
    if (unheard) sendUserMessage(UNHEARD_RESUME_MESSAGE);
  }

  /**
   * Mute on its own. Not reachable while held: the pause owns the microphone for as long as it
   * lasts, and a Mute button that appeared to do something inside a pause would be lying — the mic
   * is already muted. The button is hidden there rather than disabled, because "unmute" during a
   * pause is a request the app would have to refuse.
   */
  function toggleMute() {
    if (!connected || heldRef.current) return;
    const next = !mutedRef.current;
    setMuted(next);
    mutedRef.current = next;
    // The learner's own choice, which a pause must restore rather than override. §3.3.
    wasMutedRef.current = next;
  }

  /**
   * A held pause cannot outlive its connection. Anything that takes the line — a network drop, the
   * agent's own 30-minute cap, the End button — clears the hold here, so the screen can never show
   * a Resume button for a conversation that no longer exists.
   */
  useEffect(() => {
    if (status === "connected") return;
    // Nothing here resets the mute bit: the provider's own `onDisconnect` sets `isMuted` back to
    // false, and the effect above mirrors that into `mutedRef` on the next render. Only the
    // remembered pre-pause mute is ours to clear, because it belongs to a session that is over.
    wasMutedRef.current = false;
    // Belongs to a conversation that no longer exists: the turn it describes cannot be finished by
    // the agent that comes back, so a stale `true` would make the next resume ask a fresh session
    // to finish a sentence it never started.
    abortedRef.current = false;
    if (!heldRef.current) return;
    stopHeartbeat();
    heldRef.current = false;
    setHeld(false);
    setSilenced(true);
  }, [status, stopHeartbeat]);

  /**
   * End, the way the lock screen must do it: persist, THEN hang up.
   *
   * `endSession` reaches `persistSession` through `onDisconnect`, but a card tap can arrive with the
   * app in the background and nothing on screen, which is exactly when a callback is least likely to
   * survive long enough to finish a network call. The unmount guard already orders it this way for
   * the same reason; the per-conversation guard makes the second attempt a no-op.
   */
  const endWithPersist = useCallback(async () => {
    if (statusRef.current !== "connected") return;
    await persistSession();
    endSession();
  }, [persistSession, endSession]);

  /**
   * The three controls, reachable from a callback that must not re-subscribe when they change
   * identity. Same idiom as the unmount guard below: runs whenever, reads the latest.
   */
  const latestControls = useRef({
    togglePause: () => {},
    toggleMute: () => {},
    endWithPersist: async () => {},
  });

  // ── the lock-screen card ───────────────────────────────────────────────────────────────────
  /**
   * The Live Activity: the lesson's words and its three controls, on a locked phone.
   *
   * The rule that shapes everything here is that **Swift decides nothing**. The card is a
   * projection of this screen's state, and its buttons only record that they were pressed — what a
   * tap means is resolved below, against the state as it is when the tap is drained. Reimplementing
   * any of it natively would fork the tutor wire contract `packages/shared` exists to keep
   * singular, and would have to duplicate a mute that throws off-connection, a transcript mark that
   * decides whether a resume owes a restatement, and a feature-detected reach that silences the
   * tutor. See docs/2026-08-16-background-controls-lock-screen.md §4.2.
   */
  const activityWords = useMemo(() => active.map((item) => item.text), [active]);
  const activityState = useMemo(
    () =>
      buildActivityState({
        words: activityWords,
        connected,
        held,
        muted: isMuted,
        silenced,
        confirmingEnd,
      }),
    [activityWords, connected, held, isMuted, silenced, confirmingEnd],
  );

  /** The last state actually pushed, so an unchanged render does not reach iOS at all (§7.5). */
  const pushedRef = useRef<ActivityState | null>(null);
  /**
   * Whether a card exists — three states, not a boolean, because `start` is asynchronous and the
   * window in between is real. Without `"starting"` a second state change arriving before the first
   * `start` resolves would see "no card" and request another one.
   */
  const cardRef = useRef<"none" | "starting" | "live">("none");

  useEffect(() => {
    if (!isActivityAvailable()) return;
    if (cardRef.current === "starting") return;
    if (sameActivityState(pushedRef.current, activityState)) return;
    const state = activityState;
    pushedRef.current = state;

    // Only a live session opens a card. `phase: "over"` with no card is not a lesson that ended —
    // it is a lesson that has not begun, and there is nothing to show.
    if (cardRef.current === "none" && state.phase === "over") return;

    void (async () => {
      if (cardRef.current === "none") {
        cardRef.current = "starting";
        const id = await startActivity(
          detail?.lesson.title ?? "Lesson",
          // Built here, not in Swift: the scheme is per-variant (englishtutordev / …preview / …)
          // and expo-linking already knows which one this build is. §3.6.
          Linking.createURL(`lessons/${lessonId}`),
          state,
        );
        // Keyed off the RESULT, never off having made the call. iOS can refuse — activities are
        // switchable off per app and the system caps how many are live — and a refusal recorded as
        // success means pushing updates at nothing for the rest of the lesson.
        cardRef.current = id === null ? "none" : "live";
        if (id === null) pushedRef.current = null;
        return;
      }
      const reached = await updateActivity(state);
      if (!reached) {
        // The card is gone and we were not told: the system ended it, or the learner swiped it
        // away. Forget it, so the next state change starts a fresh one rather than shouting into
        // a dismissed card for the rest of the lesson.
        cardRef.current = "none";
        pushedRef.current = null;
      }
    })();
  }, [activityState, detail?.lesson.title, lessonId]);

  /**
   * Taps, resolved.
   *
   * The inbox — App Group `UserDefaults`, written by the intents — is the ONLY source of truth for
   * a press. The native event is a nudge to drain it, never a second delivery path: the inbox is
   * what survives the app having been terminated when the button was pressed, so making it the sole
   * channel means one path to get right instead of two that can disagree (§4.3).
   *
   * Draining also happens on every foreground transition, for exactly that case.
   */
  const drainIntents = useCallback(() => {
    const intents = drainControlIntents();
    if (intents.length === 0) return;
    const now = Date.now();
    const resolved = resolveIntents(intents, endArmedAtRef.current, now);
    endArmedAtRef.current = nextArmedAt(intents, resolved);
    setConfirmingEnd(resolved.armEndConfirm);

    const act = latestControls.current;
    if (resolved.end) {
      void act.endWithPersist();
      return;
    }
    if (resolved.togglePause) act.togglePause();
    if (resolved.toggleMute) act.toggleMute();
  }, []);

  useEffect(() => {
    latestControls.current = {
      togglePause: () => (heldRef.current ? releaseSession() : holdSession()),
      toggleMute,
      endWithPersist,
    };
  });

  /**
   * Tearing the card down, which is deliberately NOT what happens when the session ends.
   *
   * The card outlives its session because that is where `Start` lives (§3.6) — so the safety comes
   * from the state, not from the teardown: `phase: "over"` renders every control disabled and the
   * third button as a deep link, so a tap on a stale card can only open the app. It cannot mute a
   * conversation that is gone or hang one up twice.
   *
   * The card is then dismissed when the learner comes back to the app, or after a window if they
   * never do. The ordering matters and is the one thing here that must not be swapped: the state
   * push always lands before the dismissal, because a card torn down without it leaves a snapshot
   * with live-looking buttons on screen for the length of the system's animation. §7.1.
   */
  const dismissActivity = useCallback(() => {
    if (cardRef.current === "none") return;
    cardRef.current = "none";
    pushedRef.current = null;
    void endActivity();
  }, []);

  useEffect(() => {
    if (activityState.phase !== "over" || cardRef.current === "none") return;
    const timer = setTimeout(dismissActivity, OVER_CARD_LINGER_MS);
    return () => clearTimeout(timer);
  }, [activityState.phase, dismissActivity]);

  useEffect(() => {
    const subscription = addControlIntentListener(drainIntents);
    const appStateSub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      drainIntents();
      // They are back in the app: the lock-screen card has no job left, and the only reason it was
      // still up was to offer a way in.
      if (statusRef.current !== "connected") dismissActivity();
    });
    // A tap that landed while this screen was mounting has already been recorded; draining once at
    // mount is what makes the inbox a queue rather than a stream nobody was listening to.
    drainIntents();
    return () => {
      subscription.remove();
      appStateSub.remove();
    };
  }, [drainIntents, dismissActivity]);

  /**
   * An armed confirm has to lapse on its own, or a lock-screen card left showing "End lesson?" is a
   * one-tap teardown waiting for a pocket. The timer only ever DISARMS — it can never end anything.
   */
  useEffect(() => {
    if (!confirmingEnd) return;
    const timer = setTimeout(() => {
      endArmedAtRef.current = null;
      setConfirmingEnd(false);
    }, END_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmingEnd]);

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
  const latest = useRef({ persistSession, endSession, stopHeartbeat });
  useEffect(() => {
    latest.current = { persistSession, endSession, stopHeartbeat };
  });
  useEffect(
    () => () => {
      latest.current.stopHeartbeat();
      // A card for a screen that no longer exists has nothing behind its buttons.
      void endActivity();
      if (statusRef.current === "connected") {
        // A held pause becomes a parked one rather than an End: the learner never pressed End, and
        // `onDisconnect` reads this flag to leave the Paused card behind for their return.
        if (heldRef.current) pauseIntentRef.current = true;
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

  function dismissPause() {
    resumeContextRef.current = null;
    setPause(null);
    void clearPauseMarker(lessonId);
  }

  // ── render ─────────────────────────────────────────────────────────────────────────────────
  const transcript = useMemo(() => carried.concat(lines), [carried, lines]);
  /**
   * One line, four states. A paused session is `disconnected` at the transport, so reporting the
   * raw status there would say "status: disconnected" to someone looking at a Resume button.
   *
   * Pause and mute get DIFFERENT sentences on purpose. They look alike from outside — both stop the
   * learner being heard — and the thing that separates them is invisible: only a pause runs the
   * heartbeat that stops the tutor re-engaging. So the line has to carry it. §3.4.
   */
  const statusLine = held
    ? // "muted", never "off": muting reaches LiveKit's `track.mute()`, which releases the capture
      // device only when the track was published with `stopMicTrackOnMute` — and the ElevenLabs SDK
      // builds its Room without it. The microphone is silent but still open, and iOS says so with
      // the indicator. See docs/2026-08-16-tutor-pause-hold-the-line.md §4.2.
      //
      // The second variant is the tripwire for the day an SDK upgrade closes the escape hatch that
      // silences the tutor (§4.4): the pause still works, it just cannot promise quiet, and saying
      // so beats the learner discovering it through the speaker.
      silenced
      ? "⏸ paused — microphone muted, the tutor is waiting"
      : "⏸ paused — microphone muted, but the tutor may still be audible"
    : connected
      ? isMuted
        ? // The tutor is NOT waiting — it has no heartbeat holding it off, so it will re-engage
          // into the silence after `turn_timeout`. Saying "the tutor can still hear itself out" is
          // the honest version of that, and it is the difference from a pause. §3.4.
          "🎤 muted — the tutor keeps going; unmute to answer"
        : "● listening — just talk to interrupt"
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

        {/* Three slots, always in the same order, so a control never moves under the thumb that is
            reaching for it: the session verb, the pause verb, the microphone. The layout is the one
            the lock-screen card will mirror — see docs/2026-08-16-background-controls-lock-screen.md
            §5.4 — and building it here first is deliberate: this row is where the state machine
            behind those three buttons gets to be wrong somewhere visible.

            Slots two and three empty out rather than disable when there is nothing to control. A
            disabled Pause on a lesson that has not started advertises a control the learner cannot
            reach; an absent one says the same thing without inviting the tap. */}
        <ButtonRow style={{ marginTop: space.row }}>
          {connected ? (
            // The same path the lock-screen End takes: persist, then hang up. On screen there is
            // no confirm — the learner can see what they are ending, which is exactly the thing a
            // locked device cannot offer (§3.5).
            <Button label="End session" onPress={() => void endWithPersist()} />
          ) : (
            <Button
              label={busy ? "Connecting…" : "Start conversation"}
              disabled={busy}
              onPress={() => void start()}
            />
          )}
          {connected ? (
            <Button
              variant="secondary"
              label={held ? "Resume" : "Pause"}
              onPress={held ? releaseSession : holdSession}
            />
          ) : pause === "paused" ? (
            // The parked pause — the line was taken while the learner was away. Resuming it is a
            // NEW conversation handed the old one's tail, which is the lossy path; it exists as the
            // floor under the held pause, not as the pause.
            <Button
              variant="secondary"
              label="Resume"
              disabled={busy}
              onPress={() => void start()}
            />
          ) : null}
          {/* Hidden during a hold, not disabled: the pause already owns the microphone, so the only
              thing this button could offer there is an unmute the app would have to refuse. */}
          {connected && !held ? (
            <Button
              variant="secondary"
              label={isMuted ? "Unmute" : "Mute"}
              onPress={toggleMute}
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
