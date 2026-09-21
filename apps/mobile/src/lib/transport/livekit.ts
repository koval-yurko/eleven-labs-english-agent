import { API_V2_ROUTES, isLiveKitTokenResponse } from "@tutor/shared/api";
import {
  LIVEKIT_CAPABILITIES,
  LIVEKIT_LIFECYCLE,
  LIVEKIT_RPC,
  LIVEKIT_STREAM,
  encodeWireMessage,
} from "@tutor/shared/tutor/livekit-wire";
import type {
  TutorEndReason,
  TutorStatus,
  TutorTransport,
  TutorTransportControls,
  TutorTransportEvents,
} from "@tutor/shared/tutor/transport";
import {
  ConnectionState,
  ParticipantKind,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
} from "livekit-client";
import { useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "@/api";
import { applyVoiceLessonCategory, ensureStarted, release } from "@/lib/audio-session";
import { useAccessToken } from "@/lib/auth";
import { emit } from "@/lib/diagnostics";

/**
 * The LiveKit transport: a room the phone joins, and a worker of ours dispatched into it.
 *
 * Structurally unlike the other three, and the difference drives most of this file. On
 * ElevenLabs, OpenAI and Vapi the tutor IS the far end of the connection, so "connected" and "the
 * tutor is here" are one fact. Here they are two: the phone joins a room, and LiveKit assigns a job
 * to a worker afterwards. A room can be perfectly connected with nobody in it.
 *
 * Three consequences, each of which is a rule below:
 *
 *   1. **`connected` waits for the agent to say it is ready** (`tutor.ready`), never for the room.
 *      The session sends the kickoff the instant it sees `connected`, and a kickoff spoken into an
 *      empty room is a lesson that never starts. Every other provider raced here first — the
 *      OpenAI adapter's data-channel gate and Vapi's `agent-listening` wait are the same lesson
 *      learned twice (research doc §2 Q6).
 *   2. **The agent leaving without `tutor.ending` first is `onEnd("error")`.** Its ABSENCE is the
 *      signal, not its presence: a worker that crashes cannot send anything, and a lesson that ends
 *      because the tutor died must reach the learner as the "dropped" card and a resumable pause,
 *      not as a polite goodbye (research doc §3.7).
 *   3. **`context()` goes over a text stream, never RPC.** RPC payloads cap at 15 KiB and a resume
 *      context is 20 turns × 400 chars — which in Cyrillic is 2 bytes per character and lands right
 *      on the ceiling. `LIVEKIT_STREAM.CONTEXT` has no limit; the size routing that proves it lives
 *      in `@tutor/shared/tutor/livekit-wire` and is checked by `pnpm check:shared`.
 *
 * **This file asserts the audio session itself** (research doc §2 Q7). LiveKit ships
 * `useIOSAudioManagement`, which would configure AVAudioSession for the `Room` — and that is
 * exactly what `lib/audio-session.ts` exists to prevent two owners of. The session is one
 * process-wide resource whose loser fails as silence rather than as an error, so the policy stays
 * in that module and this adapter calls it, the way `openai.ts` does.
 */

/** How long to wait for the worker after the room is up, before calling the lesson a failure. */
const AGENT_READY_TIMEOUT_MS = 15_000;

export function useLiveKitTransport(events: TutorTransportEvents): TutorTransport {
  const [status, setStatus] = useState<TutorStatus>("disconnected");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  /**
   * The session rebuilds its callbacks on every render, so they are read through a ref — a
   * transport that captured the first set would stop reporting the moment anything changed
   * (`./types.ts`).
   */
  const accessToken = useAccessToken();
  const eventsRef = useRef(events);
  const tokenRef = useRef(accessToken);
  // In an effect, not during render — the same sync the other adapters do, and writing a ref
  // during render is a lint error besides.
  useEffect(() => {
    eventsRef.current = events;
    tokenRef.current = accessToken;
  });

  const roomRef = useRef<Room | null>(null);
  const agentRef = useRef<RemoteParticipant | null>(null);
  const remoteAudioRef = useRef<RemoteAudioTrack | null>(null);
  /** `tutor.ending` arrived, so the agent leaving next is a goodbye rather than a crash. */
  const endingRef = useRef(false);
  /** `onEnd` fires exactly once per session, whichever path gets there first. */
  const endedRef = useRef(false);
  const hangingUpRef = useRef(false);
  const readyRef = useRef(false);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const live = useRef({
    /**
     * The one place `connected` is announced. Called from the `tutor.ready` RPC, and deliberately
     * from nowhere else — not from `RoomEvent.Connected`, not from the agent merely joining.
     */
    markReady(): void {
      if (readyRef.current || endedRef.current) return;
      readyRef.current = true;
      if (readyTimerRef.current) {
        clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      }
      setStatus("connected");
      eventsRef.current.onStatus("connected");
    },

    teardown(reason: TutorEndReason): void {
      if (endedRef.current) return;
      endedRef.current = true;

      if (readyTimerRef.current) {
        clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      }

      const room = roomRef.current;
      roomRef.current = null;
      agentRef.current = null;
      remoteAudioRef.current = null;
      void room?.disconnect();

      // We started the audio session, so we stop it — the same ownership rule `openai.ts` follows.
      // The ElevenLabs adapter must never do this; its SDK stops the session globally.
      void release();

      setStatus("disconnected");
      setIsSpeaking(false);
      emit({
        level: reason === "error" ? "error" : "info",
        code: "transport.disconnect",
        provider: "livekit",
        message: `session ended (${reason})`,
      });
      eventsRef.current.onStatus("disconnected");
      eventsRef.current.onEnd(reason);
    },

    /**
     * Fire-and-forget RPC to the agent. A control the worker never accepted is reported rather than
     * swallowed: a lost `say` or `cancelTurn` is a tutor that visibly ignored the learner, and
     * without this the only trace would be the silence itself.
     */
    rpc(method: string, payload: string): void {
      const room = roomRef.current;
      const agent = agentRef.current;
      if (!room || !agent) return;
      void room.localParticipant
        .performRpc({ destinationIdentity: agent.identity, method, payload })
        .catch((e: unknown) => {
          emit({
            level: "warn",
            code: "transport.rpc_failed",
            provider: "livekit",
            message: `${method}: ${e instanceof Error ? e.message : String(e)}`,
          });
        });
    },
  });

  /**
   * Built once, on `[]`, reading everything through refs: `TutorTransportControls` must keep one
   * identity for the transport's life, because screens put its members in effect dependency arrays.
   */
  const controls = useMemo<TutorTransportControls>(
    () => ({
      capabilities: LIVEKIT_CAPABILITIES,

      async start(request, onIdentified) {
        emit({
          level: "info",
          code: "transport.mint",
          provider: "livekit",
          message: `minting room token for lesson ${request.lessonId}`,
        });

        let res;
        try {
          res = await apiFetch(API_V2_ROUTES.livekitToken, tokenRef.current, {
            method: "POST",
            body: JSON.stringify({
              lessonId: request.lessonId,
              items: request.items,
              version: request.version ?? undefined,
            }),
          });
        } catch (e) {
          emit({
            level: "error",
            code: "transport.mint_failed",
            provider: "livekit",
            message: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
        if (!isLiveKitTokenResponse(res)) {
          emit({
            level: "error",
            code: "transport.mint_failed",
            provider: "livekit",
            message: "token response did not match the contract",
          });
          throw new Error("The LiveKit token response was malformed.");
        }

        emit({
          level: "info",
          code: "transport.connect",
          provider: "livekit",
          message: `joining ${res.roomName}`,
          data: { conversationId: res.conversationId, version: res.version, ...LIVEKIT_CAPABILITIES },
        });

        // The seam. Nothing below may run before it: a turn can arrive on the first frame after the
        // join and needs a row key to file under.
        await onIdentified({ conversationId: res.conversationId, version: res.version });

        endedRef.current = false;
        endingRef.current = false;
        hangingUpRef.current = false;
        readyRef.current = false;
        setIsMuted(false);
        setStatus("connecting");
        eventsRef.current.onStatus("connecting");

        try {
          // Before the room exists: without it AVAudioSession stays in a category that cannot
          // render a WebRTC audio unit, and the lesson runs perfectly and silently.
          await ensureStarted();

          const room = new Room();
          roomRef.current = room;

          /**
           * The worker's two lifecycle signals arrive as RPC calls ON US, so they are registered
           * before the room connects — a `tutor.ready` that lands in the gap between connecting and
           * registering would be a lesson that hangs at "connecting" with a healthy tutor in it.
           */
          room.registerRpcMethod(LIVEKIT_LIFECYCLE.READY, async () => {
            live.current.markReady();
            return "";
          });
          room.registerRpcMethod(LIVEKIT_LIFECYCLE.ENDING, async () => {
            endingRef.current = true;
            return "";
          });

          /**
           * Recognised by KIND, not by `LIVEKIT_AGENT_NAME`. That constant is what the token route
           * dispatches by; the identity a worker ends up with in the room is assigned by LiveKit
           * and is not the agent name, so matching on it would quietly never fire.
           */
          room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
            if (p.kind !== ParticipantKind.AGENT) return;
            agentRef.current = p;
            emit({
              level: "info",
              code: "transport.agent_joined",
              provider: "livekit",
              message: p.identity,
            });
          });

          room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
            if (p.kind !== ParticipantKind.AGENT) return;
            emit({
              level: endingRef.current ? "info" : "error",
              code: "transport.agent_left",
              provider: "livekit",
              message: endingRef.current ? "tutor finished" : "tutor left without ending the lesson",
            });
            // The absence of `tutor.ending` is the signal. A worker that crashed could not have
            // sent one, and that has to reach the learner as a dropped lesson they can resume.
            live.current.teardown(endingRef.current ? "agent" : "error");
          });

          /**
           * The tutor's speaking flag comes from the agent's own published state, not from watching
           * an audio track. The worker knows whether it is mid-turn; a track carries audio whether
           * or not anything is being said.
           */
          room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p: Participant) => {
            if (p.kind !== ParticipantKind.AGENT) return;
            setIsSpeaking(p.attributes["lk.agent.state"] === "speaking");
          });

          room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
            if (track.kind !== Track.Kind.Audio) return;
            if (track instanceof RemoteAudioTrack) remoteAudioRef.current = track;
            // Asserted again here, for the reason stage 0 proved on OpenAI: the WebRTC audio unit
            // reconfigures the session as it starts, and iOS resets the category on route changes.
            void applyVoiceLessonCategory();
          });

          room.on(RoomEvent.Disconnected, () => {
            live.current.teardown(hangingUpRef.current ? "user" : "error");
          });

          room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
            if (state === ConnectionState.Disconnected && !endedRef.current) {
              live.current.teardown(hangingUpRef.current ? "user" : "error");
            }
          });

          /**
           * Committed learner and tutor lines both arrive on LiveKit's own transcription topic.
           * Only FINAL segments become turns: an interim one would write a line per word into the
           * stored transcript, which is the mistake the Vapi adapter names in its own handler.
           */
          room.registerTextStreamHandler(LIVEKIT_STREAM.TRANSCRIPTION, (reader, participant) => {
            void (async () => {
              const text = (await reader.readAll()).trim();
              if (!text) return;
              if (reader.info.attributes?.["lk.transcription_final"] !== "true") return;
              const isAgent = participant.identity !== room.localParticipant.identity;
              eventsRef.current.onTurn({ role: isAgent ? "agent" : "user", text });
            })();
          });

          await room.connect(res.url, res.token);
          await room.localParticipant.setMicrophoneEnabled(true);
          // And once more, now that a local track exists and the unit has started.
          await applyVoiceLessonCategory();

          /**
           * The room is up; the tutor may not be. Dispatch, cold start and model warm-up all sit
           * between here and the first word, so this is generous — but it is a hard failure rather
           * than a connect-anyway backstop, because a lesson with no tutor in it has nothing to say
           * and the learner would be left talking to an empty room.
           */
          readyTimerRef.current = setTimeout(() => {
            if (readyRef.current || endedRef.current) return;
            eventsRef.current.onError("The tutor never joined the lesson.");
            live.current.teardown("error");
          }, AGENT_READY_TIMEOUT_MS);
        } catch (e) {
          // A failed START, not a session that ended: tear down without raising `onEnd`, and let
          // the caller report it.
          endedRef.current = true;
          const room = roomRef.current;
          roomRef.current = null;
          void room?.disconnect();
          void release();
          setStatus("disconnected");
          eventsRef.current.onStatus("disconnected");
          throw e;
        }
      },

      end() {
        if (endedRef.current) return;
        hangingUpRef.current = true;
        setStatus("disconnecting");
        eventsRef.current.onStatus("disconnecting");
        // Taken here rather than left to the disconnect event: a session that never reports its end
        // never gets its transcript saved.
        live.current.teardown("user");
      },

      say(text) {
        live.current.rpc(LIVEKIT_RPC.SAY, encodeWireMessage({ text }));
      },

      /**
       * A text stream, never RPC — see the file docblock. Silent by contract: the worker adds this
       * to the conversation as a note and does not answer it.
       */
      context(text) {
        const room = roomRef.current;
        const agent = agentRef.current;
        if (!room || !agent) return;
        void room.localParticipant
          .sendText(text, {
            topic: LIVEKIT_STREAM.CONTEXT,
            destinationIdentities: [agent.identity],
          })
          .then(() => {
            emit({
              level: "debug",
              code: "transport.stream_sent",
              provider: "livekit",
              message: `${LIVEKIT_STREAM.CONTEXT} (${text.length} chars)`,
            });
          })
          .catch((e: unknown) => {
            emit({
              level: "warn",
              code: "transport.rpc_failed",
              provider: "livekit",
              message: `${LIVEKIT_STREAM.CONTEXT}: ${e instanceof Error ? e.message : String(e)}`,
            });
          });
      },

      cancelTurn() {
        live.current.rpc(LIVEKIT_RPC.CANCEL_TURN, "");
      },

      /**
       * Never called: `LIVEKIT_CAPABILITIES.userActivity` is false, because nothing on this stack
       * times a silent learner out — the worker holds the session open. Present because the
       * interface requires it, and a body that quietly did something else would be worse than one
       * that does nothing.
       */
      keepAlive() {},

      setMicMuted(muted) {
        const room = roomRef.current;
        if (!room) return;
        void room.localParticipant.setMicrophoneEnabled(!muted);
        setIsMuted(muted);
      },

      setOutputSilenced(silenced) {
        const track = remoteAudioRef.current;
        if (!track) return false;
        try {
          track.setVolume(silenced ? 0 : 1);
          return true;
        } catch {
          return false;
        }
      },
    }),
    [],
  );

  // A transport that outlives its screen would hold a room and a mic open. Unmount is a teardown,
  // not a pause.
  useEffect(() => {
    const session = live.current;
    return () => {
      if (!endedRef.current && roomRef.current) session.teardown("user");
    };
  }, []);

  const state = useMemo(
    () => ({ status, isSpeaking, isMuted }),
    [status, isSpeaking, isMuted],
  );
  return useMemo(() => ({ state, controls }), [state, controls]);
}
