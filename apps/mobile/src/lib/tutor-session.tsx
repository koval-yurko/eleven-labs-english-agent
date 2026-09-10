import { API_V2_ROUTES, type TutorSessionInput } from "@tutor/shared/api";
import {
  formatResumeContext,
  HIDDEN_KICKOFF_MESSAGES,
  KICKOFF_MESSAGE,
  PAUSE_RESUME_MESSAGE,
  RESUME_MESSAGE,
  TUTOR_HEARTBEAT_MS,
  type ResumeCause,
  type TranscriptLine,
  type TutorItem,
} from "@tutor/shared/tutor/session";
import {
  applyHold,
  applyRelease,
  planHold,
  planRelease,
  type HoldSnapshot,
} from "@tutor/shared/tutor/pause";
import type {
  TutorProviderId,
  TutorStatus,
  TutorUsage,
  TutorTransport,
  TutorTransportEvents,
} from "@tutor/shared/tutor/transport";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";

import { addControlIntentListener, drainControlIntents } from "@/modules/lesson-activity";

import { apiFetch, ApiFetchError } from "@/api";
import { useAccessToken, useSession } from "@/lib/auth";
import { emit, markSessionStart, registerSnapshot } from "@/lib/diagnostics";
import { buildActivityState, resolveIntents } from "@/lib/lesson-activity-state";
import { isFinalRefusal } from "@/lib/retry-policy";
import { dismissCard, ensureCard, pushCard } from "@/lib/lesson-card";
import {
  clearJournal,
  clearPauseMarker,
  readJournal,
  readPauseMarker,
  writeJournal,
  writePauseMarker,
} from "@/lib/session-journal";
import { DEFAULT_TUTOR_PROVIDER, TUTOR_PROVIDERS } from "@/lib/transport";

/**
 * The live tutor session, hoisted out of the screen that used to own it.
 *
 * ## Why this file exists
 *
 * Everything below was `app/lessons/[id]/index.tsx` until 2026-08-21, and it moved for one reason:
 * **a session must survive navigation.** The screen ended the call on unmount — a guard with a good
 * argument behind it ("a live, billed, listening session running with nothing on screen saying so
 * is a bug") — and the cost was that opening the collection, another lesson, or even the same
 * lesson again killed the conversation the learner was in the middle of. Worse, reopening the same
 * lesson looked like it *resumed* and did not: the unmount had hung up, the remount read the parked
 * pause back off disk, and Start began a NEW conversation replaying a truncated tail.
 *
 * The guard's premise is the part that had to change, not its conclusion. A session running with
 * nothing on screen saying so is still a bug — so this provider also owns the three surfaces that
 * say so: the lock-screen card (as before), the in-app return bar (`ui/SessionBar`), and the
 * "in progress" marker on the lessons list. What ends a session now is the End button, the tutor,
 * the network, or starting a different one. Navigation is not in that list.
 *
 * ## Where it is mounted, and why it has to be there
 *
 * Inside `ConversationProvider` and **above** the router (`app/_layout.tsx`). The SDK's provider was
 * already above the router, so the transport always survived a screen change; what did not was
 * everything the screen held around it — the transcript, the conversation id, the pause machine,
 * the callbacks themselves. A transport registers its callbacks with the provider and
 * **unregisters them on unmount**, so a screen-owned turn handler stops collecting the moment the
 * learner navigates: the call would have kept running and the transcript would have stopped.
 *
 * ## What carries the voice is no longer this file's business
 *
 * Since stage 1 (docs/2026-08-22-openai-realtime-second-provider.md §7) everything vendor-shaped —
 * the SDK callbacks, the token mint, the `startSession` argument, the error wording, the volume
 * escape hatch — lives behind `@tutor/shared/tutor/transport` in `lib/transport/`. This file names
 * no provider. Where the two disagree it ASKS (`capabilities`) rather than assuming: whether a turn
 * can be cancelled without spending one, whether a held pause needs a keep-alive, whether the iOS
 * audio session is already owned. Adding a provider is a file beside `transport/elevenlabs.ts` and
 * a line in `transport/index.ts`; it is not an edit here.
 *
 * ## One session, one lesson
 *
 * There is exactly one session for the whole app, and it belongs to one lesson at a time. A screen
 * declares its interest with `focusLesson`, which is **refused while a session is live** — that
 * refusal is the whole feature. Opening lesson B while lesson A is talking leaves A's state
 * untouched; B renders as idle with a note saying where the voice is coming from, and only its
 * Start button (an explicit act) takes the session away from A.
 *
 * ## What did NOT change
 *
 * The session logic itself, line for line: the proactive kickoff, the hidden-message filter, the
 * per-conversation-id save guard, the carried transcript, the resume context, the held pause and
 * its heartbeat, the lock-screen intent drain. Their docblocks moved with them. Read them as the
 * record of decisions taken in `docs/2026-08-13-expo-s4-tutor-screen.md`,
 * `docs/2026-08-16-tutor-pause-hold-the-line.md`, `docs/2026-08-17-short-turns-and-chunked-pause.md`
 * and `docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md`.
 */

/**
 * Why the session is not running. Sourced from `onDisconnect`, never inferred.
 *
 * `reason: "user"` produces NO entry here on purpose: the learner pressed End and does not need to
 * be told what they just did. And there is no `"background"` — that failure cannot happen (S1).
 *
 * `"paused"` no longer means "the learner just pressed Pause": a pause held on a live line is the
 * `held` flag, and this is its *parked* form — written to disk only when starting a different
 * lesson takes the microphone away from a held one.
 *
 * What this drives is a DISTINCTION, which two things still read: only `"paused"` puts a Resume
 * button in the screen's button row, and only `"paused"` gets its own status line. The other three
 * exist to not be `"paused"` — they are the difference between "you stopped this" and "this
 * stopped", and the resume context they carry is spent by the next Start either way.
 */
export type PauseReason =
  | "paused" // a pause parked on disk: this lesson was held when another one took the line
  | "dropped" // reason: "error" — the connection failed (network, audio graph, LiveKit)
  | "ended" // reason: "agent" — the tutor or the server ended it (max_duration_seconds is 1800)
  | "recovered"; // a journal from a previous run was found when the lesson was focused

/**
 * What the lock screen needs to know about a lesson, pushed by whichever screen is showing it.
 *
 * It is passed in rather than fetched here because the lesson screen has already loaded all of it,
 * and a provider that re-fetched the lesson would be a second reader of the same rows that can
 * disagree with the first.
 */
export type LessonMeta = {
  title: string;
  /** Built by the screen: the scheme is per-variant and `expo-linking` knows which build this is. */
  deepLink: string;
  /** The lesson's active words, already formatted by `itemLine`. */
  words: string[];
};

export type StartInput = {
  lessonId: string;
  meta: LessonMeta;
  /** The fat shape `formatItemsList` consumes — what the adapter hands its provider at connect. */
  itemsDetailed: TutorItem[];
  version: string | null;
  /**
   * Which service to run this lesson on, taken from the chosen version's `provider`.
   *
   * `null` only in the window before `/api/v2/agent-versions` has answered, which is also the
   * window in which `version` is null — the two travel together because they ARE one choice
   * (§13 Q1/Q2). The session falls back to `DEFAULT_TUTOR_PROVIDER` rather than refusing.
   */
  provider: TutorProviderId | null;
};

/** Everything a lesson screen renders. One object, so a screen reads one context. */
export type TutorSessionState = {
  /** The lesson this state belongs to — NOT necessarily the lesson being viewed. */
  lessonId: string | null;
  status: string;
  connected: boolean;
  /** Connecting or minting a token: no second Start may be taken. */
  busy: boolean;
  ending: boolean;
  held: boolean;
  /** Did the pause actually manage to silence the tutor's audio? `false` is shown, never hidden. */
  silenced: boolean;
  muted: boolean;
  lines: TranscriptLine[];
  /** Turns from earlier, interrupted conversations of the same sitting. */
  carried: TranscriptLine[];
  pause: PauseReason | null;
  error: string | null;
  /** The agent prompt version chosen for, or reported by, this session. */
  version: string | null;
  /** Bumped when a transcript reaches the server, so the screen can refetch its history. */
  lastPersisted: { lessonId: string; at: number } | null;
};

export type TutorSessionControls = {
  /**
   * "This screen is the one the session state should describe."
   *
   * Refused while a session is live — see the file docblock. Safe to call on every render pass of
   * an effect: it returns immediately when the lesson is already focused.
   */
  focusLesson: (lessonId: string) => void;
  /** Push the title/words/deep link the lock screen should show. Ignored for a non-focused lesson. */
  syncMeta: (lessonId: string, meta: LessonMeta) => void;
  start: (input: StartInput) => Promise<void>;
  end: () => void;
  hold: () => void;
  release: () => void;
  toggleMute: () => void;
  /** Throw away a parked conversation so the next `start` begins a genuinely new one. */
  discardParked: (lessonId: string) => void;
  chooseVersion: (version: string) => void;
};

/** The narrow view every other screen needs: is something running, and where. */
export type ActiveSession = { lessonId: string; title: string; held: boolean } | null;

const StateContext = createContext<TutorSessionState | null>(null);
const ControlsContext = createContext<TutorSessionControls | null>(null);
/**
 * Deliberately a THIRD context rather than a field on the state.
 *
 * The lessons list and the return bar are mounted while the tutor is talking, and the state above
 * changes on every transcript line. Reading it to render one chip would redraw the whole list
 * several times a minute; this value changes only when the session starts, ends or pauses.
 */
const ActiveContext = createContext<ActiveSession>(null);

/** How often a held pause pings `user_activity` — see `TUTOR_HEARTBEAT_MS` for the reasoning. */
const HEARTBEAT_MS = TUTOR_HEARTBEAT_MS;

/**
 * Every provider this build can run, all of them, on every render.
 *
 * The rules of hooks are why this is written out by hand instead of looping over `TUTOR_PROVIDERS`:
 * a hook call sequence has to be the same on every render, and an adapter is inert until `start()`
 * is called, so instantiating all of them costs nothing and calling one conditionally would cost
 * correctness.
 *
 * The return type is the safety net. `Record<TutorProviderId, TutorTransport>` means adding an entry
 * to `TUTOR_PROVIDERS` and forgetting this object is a COMPILE ERROR rather than a provider that
 * silently cannot be selected.
 */
function useTutorTransports(
  eventsFor: (provider: TutorProviderId) => TutorTransportEvents,
): Record<TutorProviderId, TutorTransport> {
  return {
    elevenlabs: TUTOR_PROVIDERS.elevenlabs(eventsFor("elevenlabs")),
    openai: TUTOR_PROVIDERS.openai(eventsFor("openai")),
    // Instantiated like the others even though it cannot run a lesson — see transport/vapi.ts. The
    // rule above applies to a placeholder exactly as it does to a real adapter: skipping it here
    // because "it does nothing anyway" would make the hook sequence depend on which providers
    // happen to be implemented, which is the failure the fixed call order exists to prevent.
    vapi: TUTOR_PROVIDERS.vapi(eventsFor("vapi")),
  };
}

export function TutorSessionProvider({ children }: { children: ReactNode }) {
  const accessToken = useAccessToken();

  // ── whose session this is ──────────────────────────────────────────────────────────────────
  const [lessonId, setLessonId] = useState<string | null>(null);
  const lessonIdRef = useRef<string | null>(null);
  /**
   * The lesson the LIVE conversation belongs to, as opposed to the one currently focused.
   *
   * They are the same for as long as a session is running, because focus cannot move while it is —
   * but a disconnect frees the focus while `persistSession` may still be in flight, and a transcript
   * filed under whichever lesson the learner happened to open next is not recoverable. Every write
   * that names a conversation reads this one.
   */
  const convLessonRef = useRef<string | null>(null);
  const [meta, setMeta] = useState<LessonMeta | null>(null);
  const metaRef = useRef<LessonMeta | null>(null);

  // ── the session ────────────────────────────────────────────────────────────────────────────
  const [version, setVersion] = useState<string | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [carried, setCarried] = useState<TranscriptLine[]>([]);
  const [starting, setStarting] = useState(false);
  /**
   * The End press has been taken and the hangup is in flight. Cleared by `start`, not by the
   * disconnect that ends it — the control that reads it only renders while connected.
   */
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pause, setPause] = useState<PauseReason | null>(null);
  const [lastPersisted, setLastPersisted] = useState<{ lessonId: string; at: number } | null>(null);

  // Mirrors for the SDK callbacks (they close over the render they were created in).
  const linesRef = useRef<TranscriptLine[]>([]);
  const versionRef = useRef("");
  /** THE ROW KEY. Seeded in `start`'s `onIdentified` seam, never by a callback (S3 D23). */
  const conversationIdRef = useRef<string | null>(null);
  const savedForRef = useRef<string | null>(null);
  /**
   * What the next session will be handed, and WHY it is being handed it. One ref rather than a pair,
   * because a cause that can drift out of sync with its lines is a cause that eventually describes
   * the wrong conversation — and this value is spoken aloud by the tutor.
   */
  const resumeContextRef = useRef<{ lines: TranscriptLine[]; cause: ResumeCause } | null>(null);
  /**
   * What this conversation has cost so far, summed as the turns land.
   *
   * A ref and not state: nothing on screen shows it, and a value that changed on every turn would
   * redraw the transcript for a number the learner never sees. Reset wherever `linesRef` is — the
   * two describe the same conversation and a total that outlived its transcript would be filed
   * against the next one.
   */
  const usageRef = useRef<TutorUsage | null>(null);
  const kickedOffRef = useRef(false);
  const statusRef = useRef<TutorStatus>("disconnected");
  const startingRef = useRef(false);
  /**
   * Is the conversation the SDK is running **ours**?
   *
   * It never had to be asked before: the session and its callbacks lived on the lesson screen, so a
   * screen that was not mounted could not hear about a session it had not started. This provider is
   * mounted for the life of the app, and `ConversationProvider` composes every registered set of
   * callbacks into one — so any OTHER component running a conversation through the same provider
   * would otherwise push turns into a lesson's transcript, raise a lock-screen card for a lesson
   * nobody opened, and get a second kickoff message sent into its own conversation. The diagnostic
   * screen that first made this concrete is gone; the guard is not, because the coupling it defends
   * against is a property of the shared provider rather than of that one screen.
   *
   * Set the instant before `startSession`, cleared when the transport settles at "disconnected"
   * outside a start. A ref because the callbacks read it, a state because the render does.
   */
  const [owns, setOwns] = useState(false);
  const ownsRef = useRef(false);
  const claimSession = useCallback((next: boolean) => {
    ownsRef.current = next;
    setOwns(next);
  }, []);

  /**
   * Journal whatever is being said right now.
   *
   * Guarded on there being a conversation to journal: `start` blanks these refs while it retires a
   * session for a different lesson, and a stray line arriving in that window would otherwise be
   * filed under the key `journal:` — a lesson that does not exist and that nothing ever reads back.
   */
  const journal = useCallback(() => {
    const forLesson = convLessonRef.current;
    if (!forLesson) {
      // The guarded case, made visible. A line arriving with no conversation to file it under is
      // the exact window `start` opens while it retires a session for a different lesson — rare,
      // correct to drop, and indistinguishable from a journal that is simply not writing.
      emit({ level: "warn", code: "journal.write_failed", message: "a line arrived with no conversation to journal it under" });
      return;
    }
    void writeJournal({
      lessonId: forLesson,
      conversationId: conversationIdRef.current,
      agentVersion: versionRef.current,
      lines: linesRef.current,
    });
  }, []);

  /**
   * Persist ONE conversation, once per conversation id, then tell the screen to refresh.
   *
   * It takes the conversation explicitly rather than reading the refs, because the one caller that
   * cannot use the refs is the one that matters: `start` retiring a session in order to take the
   * line for a different lesson. The refs are about to describe the NEW conversation, and a
   * transcript filed under whichever lesson the learner opened next is not recoverable.
   *
   * Best-effort: a failed save must not break the UI — the post-call webhook is the backstop and the
   * journal keeps the local copy either way.
   */
  const persistConversation = useCallback(
    async (payload: {
      lessonId: string | null;
      conversationId: string | null;
      agentVersion: string;
      lines: TranscriptLine[];
      usage: TutorUsage | null;
    }) => {
      const { lessonId: forLesson, conversationId, agentVersion, lines: transcript, usage } = payload;
      /**
       * The three no-ops, said out loud.
       *
       * Every one of them is correct, and every one of them looks identical from outside to a save
       * that failed: a transcript that is not on the server after a lesson is the failure that
       * cannot be recovered after the fact, so "it was already saved" and "there was nothing to
       * save" have to be distinguishable from "the write was refused".
       */
      if (!conversationId || !forLesson || savedForRef.current === conversationId || transcript.length === 0) {
        emit({
          level: "debug",
          code: "persist.skipped",
          message: "nothing to persist",
          data: {
            reason: !conversationId
              ? "no_conversation"
              : !forLesson
                ? "no_lesson"
                : savedForRef.current === conversationId
                  ? "already_saved"
                  : "empty_transcript",
            lines: transcript.length,
          },
        });
        return;
      }
      savedForRef.current = conversationId;

      const body: TutorSessionInput = {
        lessonId: forLesson,
        conversationId,
        agentVersion,
        lines: transcript,
        // Omitted rather than sent as zeroes when the provider does not report it: the server treats
        // a present-but-empty total as a real measurement of a free lesson, which it is not.
        ...(usage ? { usage } : {}),
      };
      try {
        await apiFetch(API_V2_ROUTES.lessonSession, accessToken, {
          method: "POST",
          body: JSON.stringify(body),
        });
        await clearJournal(forLesson);
        emit({
          level: "info",
          code: "persist.ok",
          message: "transcript saved",
          data: { conversationId, lessonId: forLesson, lines: transcript.length },
        });
        // The screen used to call `load()` straight from here. It cannot any more — this runs above
        // the router and the screen may not even be mounted — so the refresh is a fact it publishes
        // and the screen reacts to.
        setLastPersisted({ lessonId: forLesson, at: Date.now() });
      } catch (e) {
        // The status and code, not just the sentence: a 404 here means the lesson was soft-deleted
        // on another client, a 401 means the token died mid-lesson, and a 0 means the network went.
        // On screen all three are the same thing, which is nothing.
        emit({
          level: "error",
          code: "persist.failed",
          message: e instanceof Error ? e.message : String(e),
          data: {
            conversationId,
            lessonId: forLesson,
            lines: transcript.length,
            status: e instanceof ApiFetchError ? e.status : null,
            code: e instanceof ApiFetchError ? (e.code ?? null) : null,
          },
        });
        // Un-guard so a later attempt can retry: a lost transcript is the one failure that cannot be
        // recovered after the fact.
        savedForRef.current = null;
      }
    },
    [accessToken],
  );

  /** The same, for the conversation the refs currently describe. */
  const persistSession = useCallback(
    () =>
      persistConversation({
        lessonId: convLessonRef.current,
        conversationId: conversationIdRef.current,
        agentVersion: versionRef.current,
        lines: linesRef.current,
        usage: usageRef.current,
      }),
    [persistConversation],
  );

  /**
   * What the transport tells this session.
   *
   * Rebuilt every render — the adapter holds it in a ref and reads the latest, which is its
   * contract, not this file's problem. What this file still owns is the OWNERSHIP GUARD on every
   * handler, and that stays here rather than moving into the adapter because what it defends
   * against is a session-level fact: `ConversationProvider` composes every registered set of
   * callbacks, so any other component running a conversation would otherwise push turns into a
   * lesson's transcript, raise a lock-screen card for a lesson nobody opened, and get a second
   * kickoff sent into its own conversation.
   */
  const events: TutorTransportEvents = {
    onTransportId: (transportId, kind) => {
      if (!ownsRef.current) return;
      // ADVISORY ONLY — compared, never written to the ref. ElevenLabs derives this from the LiveKit
      // room name and falls back to `room_<timestamp>` when that name is empty, which no other
      // writer would ever produce. S3 measured them agreeing; this is the tripwire for the day they
      // stop.
      //
      // Only a `"row-key"` is comparable. A `"provider-handle"` is the provider's own id for the
      // call — OpenAI's `rtc_...` — and our row key is a uuid the token route minted, so the two
      // disagree by construction. Comparing them anyway is what made every OpenAI lesson raise a
      // banner and an `error`-level event for a session that was working perfectly (reports
      // `216f724b`, `ef0305f7`).
      if (kind !== "row-key") return;
      const authoritative = conversationIdRef.current;
      if (authoritative && transportId !== authoritative) {
        // The tripwire finally leaves a trace. Until now this only ever set a string on a screen
        // that may not be mounted, and the day the two ids stop agreeing is the day it matters that
        // BOTH of them were written down.
        emit({
          level: "error",
          code: "session.id_mismatch",
          message: "the transport reported an id that is not the row key",
          data: { transportId, conversationId: authoritative },
        });
        setError(`Session id mismatch (${transportId}). The transcript is still saved correctly.`);
      }
    },
    onTurn: ({ role, text }) => {
      if (!ownsRef.current) return;
      // The kickoff is the trigger, not something the learner said — every other writer filters it
      // out of the stored history, so it must not be collected here either.
      if (role === "user" && HIDDEN_KICKOFF_MESSAGES.includes(text)) return;
      linesRef.current = [...linesRef.current, { role, text }];
      setLines(linesRef.current);
      // Journal as we go: a crash or a force-quit never runs the disconnect path.
      journal();
    },
    /**
     * Barge-in. Without this the record claims the teacher finished sentences the learner cut off —
     * in an app whose whole premise is interrupting freely.
     */
    onTurnCorrected: (previous, corrected) => {
      if (!ownsRef.current) return;
      const index = linesRef.current.findLastIndex(
        (l) => l.role === "agent" && l.text === previous,
      );
      if (index === -1) return;
      const next = [...linesRef.current];
      next[index] = { role: "agent", text: corrected };
      linesRef.current = next;
      setLines(next);
      journal();
    },
    onUsage: (usage) => {
      if (!ownsRef.current) return;
      const total = usageRef.current;
      usageRef.current = total
        ? {
            inputTokens: total.inputTokens + usage.inputTokens,
            outputTokens: total.outputTokens + usage.outputTokens,
            inputAudioTokens: total.inputAudioTokens + usage.inputAudioTokens,
            outputAudioTokens: total.outputAudioTokens + usage.outputAudioTokens,
            cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
          }
        : usage;
    },
    onStatus: (next) => {
      // The TRANSITION, not the value: `${from} → ${to}` is what reconstructs a sequence, and the
      // sequence is what the report exists to carry. Unguarded by ownership exactly as the ref
      // itself is — this tracks the transport, not the conversation.
      emit({
        level: "debug",
        code: "session.status",
        message: `${statusRef.current} → ${next}`,
        data: { from: statusRef.current, to: next, owns: ownsRef.current },
      });
      statusRef.current = next;
    },
    onEnd: (reason) => {
      if (!ownsRef.current) return;
      emit({
        level: reason === "error" ? "error" : "info",
        code: "session.end",
        message: `session ended (${reason})`,
        data: {
          reason,
          lines: linesRef.current.length,
          // Whether the verdict below is allowed to land on a screen: a disconnect arriving after
          // the focus has moved must not write itself onto another lesson.
          stillFocused: convLessonRef.current !== null && convLessonRef.current === lessonIdRef.current,
        },
      });
      kickedOffRef.current = false;
      const forLesson = convLessonRef.current;
      void persistSession();
      /**
       * Why the line went down, read rather than inferred — the transport says so.
       *
       * There is no "the learner meant this" branch here any more, and its absence is the shape of
       * the change. It existed because leaving the screen hung up a held pause, so a teardown had
       * to be told apart from an End; now leaving does nothing, and the only thing that takes a
       * held line away is `start` on a different lesson — which parks its own marker on the way out
       * and blanks these refs, so this callback finds nothing of that session left to interpret.
       *
       * `stillFocused` is the other half of the same guard: a disconnect that lands after the state
       * has moved to another lesson must not write its verdict onto that lesson's screen.
       */
      const stillFocused = forLesson !== null && forLesson === lessonIdRef.current;
      if (!stillFocused) return;
      if (reason === "error") setPause("dropped");
      else if (reason === "agent") setPause("ended");
      // "user" — the learner pressed End and knows it. No card, and nothing carried: End is a full
      // stop, and continuing is what Pause/Resume is for.
      if (reason !== "user" && linesRef.current.length > 0) {
        resumeContextRef.current = { lines: linesRef.current, cause: "interrupted" };
      }
    },
    /**
     * Already one sentence, worded by the adapter — see `TutorTransportEvents.onError` for why the
     * branching cannot be shared. A denied microphone arrives here like everything else, because the
     * transport raises the OS prompt itself rather than pre-flighting it.
     */
    onError: (message) => {
      if (!ownsRef.current) return;
      // The adapter has already logged the STRUCTURED half under `transport.error`. This is the
      // sentence the learner is actually looking at, which is the other thing an investigation
      // needs — the report should be able to say what was on screen, not only what was on the wire.
      emit({
        level: "error",
        code: "session.error",
        message,
      });
      setError(message);
    },
  };

  /**
   * The provider this session is running on, and the guard that keeps the idle one quiet.
   *
   * **Every adapter is instantiated on every render** — the rules of hooks require it — so both are
   * live objects listening for their SDK's events at all times. Only one of them is carrying a
   * lesson. Without this filter the idle transport's status changes would land in `statusRef`, which
   * is unguarded by design because it tracks the transport rather than the conversation, and a
   * `"disconnected"` from the provider nobody is using would read as the live session dropping.
   *
   * A ref rather than the state, because the wrapped handlers are called from outside a render and
   * must see the takeover the instant `start` commits to it — not a frame later.
   */
  const [provider, setProvider] = useState<TutorProviderId>(DEFAULT_TUTOR_PROVIDER);
  const providerRef = useRef<TutorProviderId>(DEFAULT_TUTOR_PROVIDER);
  const eventsFor = (forProvider: TutorProviderId): TutorTransportEvents => {
    const mine = () => providerRef.current === forProvider;
    return {
      onTransportId: (id, kind) => mine() && events.onTransportId(id, kind),
      onTurn: (line) => mine() && events.onTurn(line),
      onTurnCorrected: (previous, corrected) => mine() && events.onTurnCorrected(previous, corrected),
      onStatus: (next) => mine() && events.onStatus(next),
      onUsage: (usage) => mine() && events.onUsage(usage),
      onEnd: (reason) => mine() && events.onEnd(reason),
      onError: (message) => mine() && events.onError(message),
    };
  };
  /**
   * `tx` is the STABLE half and the state is the volatile half — see `TutorTransportControls`.
   * Every control below is built on `tx` alone, which is what keeps `useTutorControls()` the
   * "stable object, safe in a dependency array" it advertises: a screen puts `focusLesson` and
   * `syncMeta` in effect deps, and a controls object that churned whenever `isSpeaking` flipped
   * would re-run those several times a minute for the whole of a lesson.
   */
  const transports = useTutorTransports(eventsFor);
  const { state: transportState, controls: tx } = transports[provider];
  const { status, isMuted, isSpeaking } = transportState;

  /**
   * `owns` and `!starting` are both load-bearing. Ownership keeps another component's session out
   * of this state machine; `!starting` covers the half-beat of a takeover, where the
   * outgoing conversation is still reported as connected while the incoming one is being minted —
   * without it, the screen that just pressed Start flashes an "End session" button belonging to a
   * lesson it is replacing.
   */
  const connected = owns && !starting && status === "connected";
  const busy = starting || (owns && status === "connecting");

  /**
   * Ownership ends where the transport does — but NOT during a start, which is exactly the window
   * where a takeover has just hung up one conversation and is minting the token for the next.
   * `startingRef` is raised before the outgoing session is ended for that reason.
   */
  useEffect(() => {
    if (status !== "disconnected" || startingRef.current) return;
    claimSession(false);
  }, [status, claimSession]);

  // ── the held pause ─────────────────────────────────────────────────────────────────────────
  /**
   * Pause WITHOUT hanging up: mute the microphone, silence the output, and keep the turn timer from
   * expiring with a `user_activity` heartbeat. The conversation stays open, so the tutor keeps its
   * own context and there is nothing to hand over on the way back — which is the entire point. The
   * shipped alternative (end the session, replay the tail into a new one) is structurally lossy.
   * See docs/2026-08-16-tutor-pause-hold-the-line.md §1.
   */
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * What the current hold captured — where the transcript stood, when it began, whether we barged
   * in, and the learner's own mute bit. One ref rather than four, because they describe one moment
   * and four refs that can drift apart is four ways to answer the wrong question on the way back.
   *
   * `null` whenever no pause is held, which is also how a dead line discards one.
   */
  const snapshotRef = useRef<HoldSnapshot | null>(null);
  /** `isSpeaking`, readable from outside a render — the hold path runs from an intent drain too. */
  const speakingRef = useRef(false);
  useEffect(() => {
    speakingRef.current = isSpeaking;
  });
  const [silenced, setSilenced] = useState(true);
  /**
   * The mute bit is NOT stored here — `useConversation` already owns it. This ref exists only
   * because two readers are outside a render (the hold path and the lock-screen intent drain).
   */
  const mutedRef = useRef(false);
  useEffect(() => {
    mutedRef.current = isMuted;
  });

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current !== null) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const hold = useCallback(() => {
    if (!ownsRef.current || statusRef.current !== "connected" || heldRef.current) return;
    /**
     * Every decision the pause makes is in `planHold` — which of the three barge-in mechanisms
     * applies, whether a keep-alive is even needed, and what has to be remembered for the way back.
     * It is pure, it is property-checked over the full cross-product in `pnpm check:shared`, and
     * that is the point: this branch used to be reachable only on a phone, in a billed session, and
     * getting it wrong shows up as the tutor saying a plausible wrong thing.
     */
    const plan = planHold(tx.capabilities, {
      speaking: speakingRef.current,
      muted: mutedRef.current,
      lineCount: linesRef.current.length,
      at: Date.now(),
    });
    snapshotRef.current = plan.snapshot;
    /**
     * The PLAN, not just "a pause happened".
     *
     * `planHold` is pure and property-checked over the full cross-product in `pnpm check:shared`,
     * and its docblock says why: "this branch used to be reachable only on a phone, in a billed
     * session, and getting it wrong shows up as the tutor saying a plausible wrong thing." Logging
     * which branch it took closes that loop from the other end — when the tutor DOES say a
     * plausible wrong thing, the report names the branch that produced it.
     */
    emit({
      level: "info",
      code: "pause.hold_plan",
      message: `hold: barge-in ${plan.bargeIn}`,
      data: {
        bargeIn: plan.bargeIn,
        heartbeat: plan.heartbeat,
        aborted: plan.snapshot.aborted,
        atLine: plan.snapshot.atLine,
        wasMuted: plan.snapshot.wasMuted,
      },
    });
    // `applyHold` reports whether the tutor was ACTUALLY silenced. `false` means it is still
    // audible, and the paused status line says so rather than claiming a silence we did not
    // deliver (`@/lib/agent-audio`).
    const silencedNow = applyHold(tx, plan);
    // Separate from the plan above: the plan is what we INTENDED, this is what the audio graph
    // actually did. `silenced: false` is a tutor still talking into a paused lesson.
    emit({
      level: silencedNow ? "info" : "warn",
      code: "pause.hold",
      message: silencedNow ? "held" : "held, but the tutor could not be silenced",
      data: { silenced: silencedNow },
    });
    setSilenced(silencedNow);
    mutedRef.current = true;
    // The timer stays here: `tutor-pause` decides WHETHER one is needed, this file owns it, because
    // an interval is a resource with a lifetime and a pure planner has no business holding one.
    if (plan.heartbeat) {
      // Once IMMEDIATELY, then on the interval. `setInterval` first fires a whole `HEARTBEAT_MS`
      // late, and the platform's own turn timer does not restart when the learner presses Pause —
      // it may already be a hair from expiring. That gap is a tutor taking the floor in the first
      // second of a pause, and on OpenAI, where the keep-alive SUSPENDS the timeout rather than
      // pushing it out (`transport/openai.ts`), the suspension may as well be in place before the
      // pause is announced. Harmless on ElevenLabs: one extra `user_activity` ping.
      tx.keepAlive();
      heartbeatRef.current = setInterval(() => tx.keepAlive(), HEARTBEAT_MS);
    }
    heldRef.current = true;
    setHeld(true);
  }, [tx]);

  const release = useCallback(() => {
    if (!heldRef.current) return;
    stopHeartbeat();
    heldRef.current = false;
    setHeld(false);
    // Spent whether or not the line survived: the turn it describes cannot be finished by whatever
    // agent comes back next.
    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    // The line died while the pause was held: `setMicMuted` throws with no active conversation, and
    // the provider has already reset its own mute state on disconnect. The drop path owns this.
    if (!ownsRef.current || statusRef.current !== "connected" || !snapshot) {
      // "Resume did nothing" is what this looks like on screen, and the three causes are very
      // different: someone else's conversation, a line that already dropped, or a hold that was
      // never taken.
      emit({
        level: "warn",
        code: "pause.release",
        message: "release found nothing to resume",
        data: { owns: ownsRef.current, status: statusRef.current, hadSnapshot: snapshot !== null },
      });
      return;
    }
    /**
     * What the learner is owed, in exactly three cases — and each of the two that speak is bounded
     * to ONE turn. The tutor was listening (nothing lost), cut off (owed the tail of one thought),
     * or talking unheard (owed that point restated). `planRelease` decides; `pnpm check:shared`
     * pins the table, including that a cut-off turn outranks an unheard one.
     */
    const plan = planRelease(snapshot, { lines: linesRef.current, at: Date.now() });
    // Which of the three the learner was owed. `say` is the whole answer: null (nothing lost),
    // `ABORTED_RESUME_MESSAGE` (cut off), or `UNHEARD_RESUME_MESSAGE` (talked unheard) — and the
    // wrong one of those is the tutor plausibly continuing the wrong thought.
    emit({
      level: "info",
      code: "pause.release_plan",
      message: plan.say ? "release: the tutor owes one turn" : "release: nothing owed",
      data: {
        owed: plan.say === null ? "none" : snapshot.aborted ? "aborted" : "unheard",
        micMuted: plan.micMuted,
        heldMs: Date.now() - snapshot.since,
      },
    });
    applyRelease(tx, plan);
    mutedRef.current = plan.micMuted;
    setSilenced(true);
  }, [tx, stopHeartbeat]);

  /**
   * Mute on its own. Not reachable while held: the pause owns the microphone for as long as it
   * lasts, and a Mute button that appeared to do something inside a pause would be lying.
   */
  const toggleMute = useCallback(() => {
    if (!ownsRef.current || statusRef.current !== "connected" || heldRef.current) return;
    const next = !mutedRef.current;
    tx.setMicMuted(next);
    mutedRef.current = next;
    // No second copy of this bit: the next `planHold` reads `mutedRef` and puts the learner's own
    // choice into its snapshot, so a pause restores it rather than overriding it. §3.3.
  }, [tx]);

  /**
   * A held pause cannot outlive its connection. Anything that takes the line — a network drop, the
   * agent's own 30-minute cap, the End button — clears the hold here, so no screen can ever show a
   * Resume button for a conversation that no longer exists.
   */
  useEffect(() => {
    if (status === "connected") return;
    // Belongs to a conversation that no longer exists: the turn it describes cannot be finished by
    // the agent that comes back.
    snapshotRef.current = null;
    if (!heldRef.current) return;
    stopHeartbeat();
    heldRef.current = false;
    setHeld(false);
    setSilenced(true);
  }, [status, stopHeartbeat]);

  /**
   * End. **Hang up FIRST, and never behind a network call.**
   *
   * `persistSession` goes through `apiFetch`, which awaits `getCredentials()` — a network round trip
   * — and then a `fetch` with no timeout. Awaiting it first is how the button came to do nothing on
   * a weak network. Persisting is not lost by going second: `onDisconnect` calls it on every
   * disconnect, the journal is on disk from `onMessage`, and the post-call webhook writes the same
   * row server-side. See docs/2026-08-20-words-1.6-lock-screen-translations-and-lesson-words.md §2.
   */
  const end = useCallback(() => {
    setEnding(true);
    // END IS A FULL STOP. Nothing about this conversation may be handed to the next one: the next
    // Start gets a clean lesson, and continuing is what Pause/Resume is for.
    resumeContextRef.current = null;
    const forLesson = convLessonRef.current;
    if (forLesson) void clearPauseMarker(forLesson);
    tx.end();
    void persistSession();
  }, [tx, persistSession]);

  /**
   * A session that ends takes the conversation with it.
   *
   * The tutor does not stop talking when the app signs itself out: LiveKit is already connected and
   * needs no further token, so the call runs on — while every control for it is behind the gate that
   * is now showing a sign-in screen (`lib/auth.tsx`). A billed conversation nobody can hang up is
   * the worst version of the bug this repair is for, so ending the session is part of ending the
   * session. `end` persists what it has; that write will fail while signed out and is swallowed, as
   * it is for every other failed persist — the post-call webhook is the backstop.
   */
  const signedOut = useSession().status === "signed-out";
  useEffect(() => {
    if (!signedOut || !ownsRef.current || statusRef.current === "disconnected") return;
    end();
  }, [signedOut, end]);

  // ── focus: which lesson the state above describes ──────────────────────────────────────────
  /**
   * Invalidates an in-flight disk restore. A screen can be opened and left again before
   * `readJournal` resolves, and a restore that landed after the learner moved on would show one
   * lesson's parked pause on another lesson's screen.
   */
  const restoreTokenRef = useRef(0);

  /**
   * Read what a previous run left on disk for this lesson. Two things can be waiting, checked in
   * this order:
   *
   *   1. **A journal** — the last session died without saving: a crash or a force-quit, since
   *      backgrounding is survivable here. Push it to the server, then offer to carry on — and
   *      **keep it on disk if the push did not get an answer**, so the next focus tries again. See
   *      the push below for why that condition is the 4xx/5xx split and not "did it work".
   *   2. **A pause marker** — the learner pressed Pause and then left (or the app restarted). The
   *      transcript was already saved on the way out; the marker only restores the context.
   *
   * The journal wins when both exist, because both existing means the save at pause time FAILED —
   * so the unsaved copy is the one that has to reach the server. Its copy ("ended unexpectedly") is
   * then also the true one.
   */
  const restoreParked = useCallback(
    async (forLesson: string, token: number) => {
      const stale = () => restoreTokenRef.current !== token || lessonIdRef.current !== forLesson;
      const unsaved = await readJournal(forLesson);
      if (stale()) return;
      if (!unsaved || unsaved.lines.length === 0) {
        const marker = await readPauseMarker(forLesson);
        if (stale() || !marker || marker.lines.length === 0) return;
        emit({
          level: "info",
          code: "pausemarker.restore",
          message: "a parked pause was found on disk",
          data: { lessonId: forLesson, lines: marker.lines.length },
        });
        setCarried(marker.lines);
        resumeContextRef.current = { lines: marker.lines, cause: "paused" };
        setPause("paused");
        return;
      }
      await clearPauseMarker(forLesson);
      /**
       * Push the unsaved transcript, and let the ANSWER decide whether the journal may be deleted.
       *
       * This used to clear unconditionally, on the reasoning that "the post-call webhook is the
       * backstop". **That is false for OpenAI**, which has no webhook and no post-call transcript
       * endpoint — `/api/v2/lessons/session` says so itself: *"this write is the only witness there
       * is"*. So a crash followed by a relaunch with no signal deleted the only copy of the lesson
       * that existed anywhere. The journal is insurance, and insurance that cancels itself the one
       * time it is claimed is not insurance.
       *
       * The rule is the spool's (§11.1), and it is the same rule for the same reason:
       *
       *   - **2xx** — stored. Clear.
       *   - **4xx** — the server has ANSWERED. A lesson that was soft-deleted, or one that is not
       *     this owner's, will refuse this write on every future launch too; keeping the journal
       *     would be a retry that can never succeed, once per focus, forever.
       *   - **5xx, network, not signed in** — nobody has answered. Keep it, and let the next focus
       *     of this lesson try again.
       *
       * KNOWN GAP, and it is the existing contract rather than something introduced here: a
       * retained journal is still cleared by the next `start` on this lesson (the seam in `start`
       * clears it so a stale journal cannot outlive its conversation, and the key is per-lesson).
       * So retention buys every retry up to the next Start, not an unbounded queue. Closing that
       * window means keying the journal per CONVERSATION, which is a bigger change than this one.
       */
      let retained = false;
      if (unsaved.conversationId) {
        try {
          await apiFetch(API_V2_ROUTES.lessonSession, accessToken, {
            method: "POST",
            body: JSON.stringify({
              lessonId: forLesson,
              conversationId: unsaved.conversationId,
              agentVersion: unsaved.agentVersion,
              lines: unsaved.lines,
            } satisfies TutorSessionInput),
          });
          emit({
            level: "info",
            code: "persist.ok",
            message: "a recovered journal reached the server",
            data: { lessonId: forLesson, conversationId: unsaved.conversationId, lines: unsaved.lines.length },
          });
          setLastPersisted({ lessonId: forLesson, at: Date.now() });
        } catch (e) {
          const status = e instanceof ApiFetchError ? e.status : 0;
          retained = !isFinalRefusal(status);
          emit({
            level: "error",
            code: retained ? "journal.retained" : "persist.failed",
            message: e instanceof Error ? e.message : String(e),
            data: {
              lessonId: forLesson,
              conversationId: unsaved.conversationId,
              lines: unsaved.lines.length,
              status,
              code: e instanceof ApiFetchError ? (e.code ?? null) : null,
              // The whole decision, in one field: was this transcript kept or given up on?
              retained,
            },
          });
        }
      }
      // A journal with no conversation id has no row key and can never be filed under one, so there
      // is nothing to retain — it is offered as context below and then discarded.
      if (!retained) await clearJournal(forLesson);
      if (stale()) return;
      // A journal means the LAST session died without saving — a crash or a force-quit, since
      // backgrounding is survivable here. Rare, real, and the one recovery worth being able to
      // count: if it stops being rare, that is the finding.
      emit({
        level: "warn",
        code: "journal.restore",
        message: retained
          ? "an unsaved journal was recovered and KEPT — the server could not be reached"
          : "an unsaved journal was recovered from disk",
        data: {
          lessonId: forLesson,
          conversationId: unsaved.conversationId,
          lines: unsaved.lines.length,
          // So one event answers both halves: what was found, and whether it is still on the device.
          retained,
        },
      });
      setCarried(unsaved.lines);
      resumeContextRef.current = { lines: unsaved.lines, cause: "interrupted" };
      setPause("recovered");
    },
    [accessToken],
  );

  const focusLesson = useCallback(
    (next: string) => {
      if (lessonIdRef.current === next) return;
      // THE REFUSAL THAT IS THE FEATURE. A live — or connecting — session owns this state, and
      // opening another screen is not a request to take it away. Only `start` does that.
      //
      // Logged because the refusal IS the feature: a refusal that leaves no trace is
      // indistinguishable from a button that did nothing, and "opening lesson B shows lesson A's
      // state" is exactly what a correct refusal looks like from the outside.
      if ((ownsRef.current && statusRef.current !== "disconnected") || startingRef.current) {
        emit({
          level: "info",
          code: "session.start_refused",
          message: "focus refused — a session is live",
          data: {
            requested: next,
            focused: lessonIdRef.current,
            live: convLessonRef.current,
            status: statusRef.current,
            starting: startingRef.current,
          },
        });
        return;
      }

      emit({
        level: "info",
        code: "session.focus",
        message: "focus moved",
        data: { from: lessonIdRef.current, to: next },
      });
      lessonIdRef.current = next;
      const token = ++restoreTokenRef.current;
      linesRef.current = [];
      usageRef.current = null;
      conversationIdRef.current = null;
      savedForRef.current = null;
      resumeContextRef.current = null;
      versionRef.current = "";
      kickedOffRef.current = false;
      convLessonRef.current = null;
      metaRef.current = null;
      setLessonId(next);
      setMeta(null);
      setLines([]);
      setCarried([]);
      setPause(null);
      setError(null);
      setVersion(null);
      setEnding(false);
      void restoreParked(next, token);
    },
    [restoreParked],
  );

  const syncMeta = useCallback((forLesson: string, next: LessonMeta) => {
    if (lessonIdRef.current !== forLesson) return;
    const current = metaRef.current;
    if (
      current &&
      current.title === next.title &&
      current.deepLink === next.deepLink &&
      current.words.length === next.words.length &&
      current.words.every((w, i) => w === next.words[i])
    ) {
      return;
    }
    metaRef.current = next;
    setMeta(next);
  }, []);

  const chooseVersion = useCallback((next: string) => setVersion(next), []);

  const discardParked = useCallback((forLesson: string) => {
    if (lessonIdRef.current === forLesson) {
      resumeContextRef.current = null;
      setPause(null);
    }
    void clearPauseMarker(forLesson);
  }, []);

  // ── the lock-screen surfaces ───────────────────────────────────────────────────────────────
  /**
   * What the locked phone shows and what it can do, which since 2026-08-18 are two different things
   * on two different surfaces: the **card** (a Live Activity) is read-only, and the **actions** are
   * two Controls gated by their intent's own `authenticationPolicy`.
   *
   * The rule that shapes all of it is unchanged: **Swift decides nothing.** Both surfaces are
   * projections of the state above, and a control press only records that it happened — what a
   * press means is resolved below, against the state as it is when the press is drained.
   */
  const activityState = useMemo(
    () =>
      meta === null
        ? null
        : buildActivityState({
            title: meta.title,
            deepLink: meta.deepLink,
            words: meta.words,
            connected,
            held,
            muted: isMuted,
            silenced,
          }),
    [meta, connected, held, isMuted, silenced],
  );

  /**
   * Whether a card has been asked for since the last time a session was over.
   *
   * It is NOT a record of whether a card exists — that lives in `@/lib/lesson-card`, at module
   * scope, because a Live Activity outlives this screen, this navigation stack and this process.
   * What it decides is which of the two entry points to use: `ensureCard` may create a card and
   * clears the "the learner swiped it away" latch, so it belongs to a deliberate session start;
   * `pushCard` only ever updates one that already exists.
   */
  const cardRequestedRef = useRef(false);

  useEffect(() => {
    if (activityState === null) return;
    if (activityState.phase === "over") {
      // The card outlives its session, because that is where `Start` lives (§3.6). The singleton
      // owns the linger and the teardown; all this owes it is the final state.
      cardRequestedRef.current = false;
      pushCard(activityState);
      return;
    }
    if (!cardRequestedRef.current) {
      cardRequestedRef.current = true;
      ensureCard(activityState);
      return;
    }
    pushCard(activityState);
  }, [activityState]);

  /**
   * The two controls, reachable from a callback that must not re-subscribe when they change
   * identity. "Runs whenever, reads the latest."
   */
  const latestControls = useRef({ togglePause: () => {}, toggleMute: () => {} });
  useEffect(() => {
    latestControls.current = {
      togglePause: () => (heldRef.current ? release() : hold()),
      toggleMute,
    };
  });

  /**
   * Presses, resolved.
   *
   * The inbox — App Group `UserDefaults`, written by the control intents — is the ONLY source of
   * truth for a press. The native event is a nudge to drain it, never a second delivery path: the
   * inbox is what survives the app having been terminated when a control was pressed (§4.3).
   */
  const drainIntents = useCallback(() => {
    const intents = drainControlIntents();
    if (intents.length === 0) return;
    const resolved = resolveIntents(intents);
    const act = latestControls.current;
    if (resolved.togglePause) act.togglePause();
    if (resolved.toggleMute) act.toggleMute();
  }, []);

  useEffect(() => {
    const subscription = addControlIntentListener(drainIntents);
    const appStateSub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      drainIntents();
      // They are back in the app: the card has no job left, and the only reason it was still up was
      // to offer a way in.
      if (!ownsRef.current || statusRef.current !== "connected") void dismissCard();
    });
    drainIntents();
    return () => {
      subscription.remove();
      appStateSub.remove();
    };
  }, [drainIntents]);

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
    /**
     * The kickoff either happened or it did not, and today the difference is only audible.
     *
     * The effect is keyed on `status` because `WebRTCConnection.sendMessage` drops anything sent
     * before `RoomEvent.Connected` **with a console warning and no error** — so if the keying ever
     * regresses the symptom is "the tutor doesn't say hello sometimes". This line, plus the console
     * capture that now records that warning, is what turns that into a two-event story.
     */
    const resuming = Boolean(resumeFrom && resumeFrom.lines.length > 0);
    /**
     * A provider that opens the lesson by itself must not be kicked off as well.
     *
     * Only the FRESH case: `opensUnprompted` describes a greeting generated when the call is
     * created, which cannot continue an interrupted lesson — the transcript it would have to
     * continue from does not exist yet at that moment. A resume therefore still sends its context
     * and its resume message everywhere. See `TutorCapabilities.opensUnprompted`.
     */
    const opensItself = tx.capabilities.opensUnprompted && !resuming;
    emit({
      level: "info",
      code: "session.kickoff",
      message: opensItself
        ? "kickoff: none — the tutor opens by itself"
        : resumeFrom
          ? "kickoff: resuming"
          : "kickoff: fresh",
      data: {
        resumed: resuming,
        cause: resumeFrom?.cause ?? null,
        lines: resumeFrom?.lines.length ?? 0,
        sent: !opensItself,
      },
    });
    if (opensItself) return;
    if (resumeFrom && resumeFrom.lines.length > 0) {
      tx.context(formatResumeContext(resumeFrom.lines, resumeFrom.cause));
      tx.say(resumeFrom.cause === "paused" ? PAUSE_RESUME_MESSAGE : RESUME_MESSAGE);
    } else {
      tx.say(KICKOFF_MESSAGE);
    }
  }, [status, tx]);

  const start = useCallback(
    async (input: StartInput) => {
      if (startingRef.current || statusRef.current === "connecting") {
        emit({
          level: "warn",
          code: "session.start_refused",
          message: "start refused — one is already in flight",
          data: { lessonId: input.lessonId, starting: startingRef.current, status: statusRef.current },
        });
        return;
      }
      /**
       * The RELATIVE clock restarts here, and the frozen at-error snapshot is spent — the same act
       * that clears the on-screen error below. The ring itself is deliberately not cleared: the
       * events from before a Start are frequently the explanation for the Start failing.
       */
      markSessionStart();
      emit({
        level: "info",
        code: "session.start",
        message: "starting",
        provider: input.provider ?? DEFAULT_TUTOR_PROVIDER,
        data: {
          lessonId: input.lessonId,
          version: input.version,
          items: input.itemsDetailed.length,
          // A start that takes the line away from a live lesson is the one navigation-shaped act
          // that ends a session, and the takeover half-beat below is where the hardest bugs live.
          takeover: statusRef.current === "connected",
        },
      });
      // Raised HERE and not below, so the ownership effect does not read the takeover's own hangup
      // as "the session is over" while the replacement is still being minted.
      startingRef.current = true;
      /**
       * Starting a lesson while another one is talking is the ONE navigation-shaped act that ends a
       * session — and it is a button press, which is what the rule has always been.
       *
       * The retired session is settled **synchronously and explicitly**, then its refs are blanked,
       * rather than left for `onDisconnect` to deal with. `endSession` resolves whenever LiveKit
       * gets round to it, which is easily after the token mint below has re-pointed every ref at the
       * new conversation — and a callback that reads `conversationIdRef` at that moment files one
       * lesson's transcript under another. Blanked refs make the late callback a no-op instead.
       */
      if (statusRef.current === "connected") {
        const forLesson = convLessonRef.current;
        const conversationId = conversationIdRef.current;
        const agentVersion = versionRef.current;
        const previousLines = linesRef.current;
        const previousUsage = usageRef.current;
        const wasHeld = heldRef.current;
        stopHeartbeat();
        heldRef.current = false;
        setHeld(false);
        void persistConversation({
          lessonId: forLesson,
          conversationId,
          agentVersion,
          lines: previousLines,
          usage: previousUsage,
        });
        // A held pause is parked rather than discarded: the learner never pressed End on THAT
        // lesson, so it should still be waiting for them on the way back.
        if (wasHeld && forLesson && previousLines.length > 0) {
          void writePauseMarker({
            lessonId: forLesson,
            conversationId,
            agentVersion,
            lines: previousLines,
          });
        }
        conversationIdRef.current = null;
        convLessonRef.current = null;
        linesRef.current = [];
        usageRef.current = null;
        tx.end();
      }

      /**
       * Ownership of the state moves BEFORE the token round trip, not after it.
       *
       * The screen that pressed Start is the one that must render "Connecting…", and it reads that
       * from this state — so re-keying after the mint would leave it looking idle for the length of
       * a network call, with a Start button that appeared to have done nothing. A failed mint lands
       * its error on the same screen for the same reason.
       *
       * Nothing of the previous lesson's is carried across: those turns belong to a different
       * conversation, which has just been saved and (if it was held) parked.
       */
      const ownLesson = lessonIdRef.current === input.lessonId;
      if (!ownLesson) {
        lessonIdRef.current = input.lessonId;
        restoreTokenRef.current += 1; // any restore for the lesson we are leaving is now irrelevant
        resumeContextRef.current = null;
        linesRef.current = [];
        usageRef.current = null;
        setLessonId(input.lessonId);
        setLines([]);
        setCarried([]);
        setPause(null);
      }
      metaRef.current = input.meta;
      setMeta(input.meta);
      setError(null);
      setStarting(true);
      /**
       * The provider swap, and the order it has to happen in.
       *
       * The takeover above hung up on `tx` — the OUTGOING transport — which is why the swap is
       * here and not at the top: moving it earlier would have ended the wrong session. From this
       * line on, the incoming provider owns the events (the ref is what the wrapped handlers read),
       * and `next` is used directly rather than through `tx`, because a state update does not
       * change what this already-running callback closed over.
       */
      const nextProvider = input.provider ?? DEFAULT_TUTOR_PROVIDER;
      providerRef.current = nextProvider;
      setProvider(nextProvider);
      const next = transports[nextProvider].controls;

      try {
        await next.start(
          {
            lessonId: input.lessonId,
            // The fat shape. How it reaches the agent is the adapter's business — a dynamic
            // variable on one provider, server-side interpolation on another.
            items: input.itemsDetailed,
            version: input.version,
          },
          /**
           * The window between "we have a row key" and "the line is up". Everything here used to sit
           * inline between the token mint and `startSession`, and each line is here for a reason
           * spelled out in `TutorTransportControls.start`:
           *
           *   - the disk clears run AFTER the mint, so a refused mint leaves the journal and the
           *     pause marker where they are, and BEFORE the connect, so the next focus cannot offer
           *     a resume into a conversation this start has already superseded;
           *   - ownership is claimed before a callback can fire;
           *   - the row key is seeded before a turn can arrive.
           */
          async (descriptor) => {
            // Either way the next conversation starts with a transcript of its own; resuming moves
            // what was already said into the read-only carried block above it. (A lesson that has
            // just taken the session from another one has already been emptied above, so both
            // branches are `[]` for it.)
            const resuming = (resumeContextRef.current?.lines.length ?? 0) > 0;
            const previous = linesRef.current;
            setCarried(resuming ? (prev) => [...prev, ...previous] : []);
            setLines([]);
            linesRef.current = [];
            usageRef.current = null;
            await clearJournal(input.lessonId);
            // The pause is being spent — whether it is resumed or overridden by a fresh start, the
            // parked copy must not outlive this call.
            await clearPauseMarker(input.lessonId);
            savedForRef.current = null;
            kickedOffRef.current = false;
            setPause(null);
            setEnding(false);

            // From here on this is the row key, whatever the transport says its own id is.
            emit({
              level: "info",
              code: "session.claim",
              message: "ownership claimed",
              provider: null,
              data: {
                conversationId: descriptor.conversationId,
                version: descriptor.version,
                lessonId: input.lessonId,
                resuming,
              },
            });
            claimSession(true);
            conversationIdRef.current = descriptor.conversationId;
            convLessonRef.current = input.lessonId;
            versionRef.current = descriptor.version;
            setVersion(descriptor.version);
          },
        );
      } catch (e) {
        // The transport never connected, so there is no conversation of ours to own — and the
        // ownership effect cannot notice, because the transport never left "disconnected".
        emit({
          level: "error",
          code: "session.release",
          message: e instanceof Error ? e.message : String(e),
          provider: null,
          data: { reason: "start_threw", lessonId: input.lessonId },
        });
        claimSession(false);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setStarting(false);
        startingRef.current = false;
      }
    },
    [claimSession, persistConversation, stopHeartbeat, transports, tx],
  );

  /**
   * Hand the diagnostics bus a way to read this session — **a function, not a value.**
   *
   * The interesting half of this file is refs, and refs are invisible from outside: a transcript
   * filed under the wrong conversation, a save that silently no-ops, a second kickoff, a pause that
   * resumes with the wrong one of three plans. Every one of those is a hazard documented above and
   * none of them can be seen from a screen. This is the one place they can all be read at once.
   *
   * **Registered every render, with no dependency array**, and the cost of that is one closure
   * allocation and one `Set` write per render — nothing is *evaluated*. The body runs only when
   * something asks, which while the modal is closed is only the bus freezing a copy on the first
   * error. So the "no cost when closed" property is a property of the BODY, not of the deps.
   *
   * It cannot be `[]`. The five values below that are state rather than refs (`provider`,
   * `silenced`, `carried`, `error`, `tx.capabilities`) would then be pinned to the first render,
   * and routing them through a mutable ref instead — the `latest`/`latestControls` pattern this
   * file uses elsewhere — is rejected by the React Compiler's immutability rule the moment that ref
   * is read from inside a hook argument. Re-registering is the cheaper of the two answers anyway.
   *
   * `provider` is the state and not `providerRef`, for the same rule: `start` writes to that ref,
   * and reading it here would make the write a compile error. It lags by one render during a
   * takeover, which is the honest answer for a snapshot — this is what the app is rendering.
   */
  useEffect(() =>
    registerSnapshot(() => ({
      focusedLesson: lessonIdRef.current,
      conversationLesson: convLessonRef.current,
      conversationId: conversationIdRef.current,
      savedFor: savedForRef.current,
      owns: ownsRef.current,
      starting: startingRef.current,
      kickedOff: kickedOffRef.current,
      status: statusRef.current,
      provider,
      version: versionRef.current === "" ? null : versionRef.current,
      held: heldRef.current,
      silenced,
      muted: mutedRef.current,
      speaking: speakingRef.current,
      // A COUNT, not the lines. The transcript is already stored server-side under this
      // conversation id for this owner; a second copy inside a diagnostic blob is a copy that
      // outlives a deletion (§6).
      lines: linesRef.current.length,
      carried: carried.length,
      usage: usageRef.current,
      holdSnapshot: snapshotRef.current,
      resumeCause: resumeContextRef.current?.cause ?? null,
      resumeLines: resumeContextRef.current?.lines.length ?? 0,
      heartbeat: heartbeatRef.current !== null,
      capabilities: tx.capabilities,
      restoreToken: restoreTokenRef.current,
      metaTitle: metaRef.current?.title ?? null,
      lastError: error,
    })),
  );

  /**
   * The app is going away. This provider is mounted once per process, so this cleanup runs when the
   * runtime is torn down — not on navigation, which is the entire point of the file.
   */
  const latest = useRef({ persistSession, end: tx.end, stopHeartbeat });
  useEffect(() => {
    latest.current = { persistSession, end: tx.end, stopHeartbeat };
  });
  useEffect(
    () => () => {
      latest.current.stopHeartbeat();
      void dismissCard();
      if (ownsRef.current && statusRef.current === "connected") {
        void latest.current.persistSession();
        latest.current.end();
      }
    },
    [],
  );

  const state = useMemo<TutorSessionState>(
    () => ({
      lessonId,
      // Reported as idle when the conversation is not ours: the screen prints this raw in its
      // status line, and "connected" next to a Start button would be describing someone else's call.
      status: owns ? status : "disconnected",
      connected,
      busy,
      ending,
      held,
      silenced,
      // Same reasoning as `status`: the mute bit belongs to whatever conversation is running, and
      // a conversation we do not own is not one this state should describe.
      muted: owns && isMuted,
      lines,
      carried,
      pause,
      error,
      version,
      lastPersisted,
    }),
    [
      lessonId,
      owns,
      status,
      connected,
      busy,
      ending,
      held,
      silenced,
      isMuted,
      lines,
      carried,
      pause,
      error,
      version,
      lastPersisted,
    ],
  );

  const controls = useMemo<TutorSessionControls>(
    () => ({
      focusLesson,
      syncMeta,
      start,
      end,
      hold,
      release,
      toggleMute,
      discardParked,
      chooseVersion,
    }),
    [focusLesson, syncMeta, start, end, hold, release, toggleMute, discardParked, chooseVersion],
  );

  const activeTitle = meta?.title ?? "";
  const active = useMemo<ActiveSession>(
    () => (connected && lessonId ? { lessonId, title: activeTitle, held } : null),
    [connected, lessonId, activeTitle, held],
  );

  return (
    <ControlsContext.Provider value={controls}>
      <ActiveContext.Provider value={active}>
        <StateContext.Provider value={state}>{children}</StateContext.Provider>
      </ActiveContext.Provider>
    </ControlsContext.Provider>
  );
}

/** The whole session state. For the lesson screen — it redraws on every transcript line. */
export function useTutorSession(): TutorSessionState {
  const value = useContext(StateContext);
  if (!value) throw new Error("useTutorSession must be used inside a TutorSessionProvider.");
  return value;
}

/** The controls. A stable object: safe in a dependency array. */
export function useTutorControls(): TutorSessionControls {
  const value = useContext(ControlsContext);
  if (!value) throw new Error("useTutorControls must be used inside a TutorSessionProvider.");
  return value;
}

/**
 * "Is a lesson talking, and which one." Changes only when a session starts, ends or pauses — so a
 * list can render a marker without redrawing on every turn.
 */
export function useActiveSession(): ActiveSession {
  return useContext(ActiveContext);
}
