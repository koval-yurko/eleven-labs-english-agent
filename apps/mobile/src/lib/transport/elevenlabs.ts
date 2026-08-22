import { useConversation, useRawConversation } from "@elevenlabs/react-native";
import {
  conversationTokenPath,
  isConversationTokenResponse,
} from "@tutor/shared/api";
import { formatItemsList } from "@tutor/shared/tutor";
import type {
  TutorCapabilities,
  TutorTransport,
  TutorTransportControls,
  TutorTransportEvents,
} from "@tutor/shared/tutor-transport";
import { useEffect, useMemo, useRef } from "react";

import { apiFetch } from "@/api";
import { setAgentAudioVolume } from "@/lib/agent-audio";
import { useAccessToken } from "@/lib/auth";
import { tutorErrorMessage } from "@/lib/tutor-error";

/**
 * The ElevenLabs Conversational AI transport.
 *
 * Everything in this file was inlined in `lib/tutor-session.tsx` until stage 1 — the eight
 * callbacks, the token mint, the `startSession` argument, the error wording, the volume escape
 * hatch. It moved here unchanged in behaviour, and the docblocks that explain WHY each piece is the
 * way it is moved with it. Read them as the record of decisions taken in
 * docs/2026-08-13-expo-s3-conversation-token.md, docs/2026-08-16-tutor-pause-hold-the-line.md and
 * docs/2026-08-21-quota-outage-and-pause-panel.md.
 *
 * What is NOT here: the ownership guard (`if (!ownsRef.current) return`). It stays in the session,
 * because what it defends against is a property of the SHARED `ConversationProvider` composing every
 * registered set of callbacks — a session-level fact about who a conversation belongs to, not a
 * transport-level one about how to carry it.
 */

/**
 * What this provider can do, measured rather than hoped.
 *
 * `cancelTurn: false` is the interesting one: ElevenLabs has no way to stop an in-flight turn, so
 * the held pause fakes it by sending `PAUSE_STOP_MESSAGE` as a user message — which costs a turn and
 * has to be filtered back out of the transcript. The session takes that fallback BECAUSE of this
 * flag rather than because it was written for this provider.
 *
 * `managesAudioSession: true` is a statement of fact about the SDK, not a preference:
 * `@elevenlabs/react-native/src/index.react-native.ts` calls `AudioSession.configureAudio()` and
 * `startAudioSession()` in its setup strategy and `stopAudioSession()` on detach, with no option to
 * disable any of it. `lib/audio-session.ts` stays out of the way when this is true.
 */
const CAPABILITIES: TutorCapabilities = {
  // Only through the escape hatch in `lib/agent-audio.ts` — which is exactly why
  // `setOutputSilenced` returns whether it worked instead of assuming it did.
  silenceOutput: true,
  // `turn_timeout` re-engages the learner, so a held pause must keep the timer alive.
  userActivity: true,
  cancelTurn: false,
  responseCorrection: true,
  managesAudioSession: true,
};

export function useElevenLabsTransport(events: TutorTransportEvents): TutorTransport {
  const accessToken = useAccessToken();

  /**
   * The events, held so the SDK callbacks below can be STABLE.
   *
   * The session rebuilds its handler object on every render (they close over its state), and
   * `useConversation` registers whatever it is handed with the provider. Reading through a ref means
   * a callback that fires between renders runs the newest handler rather than the one that happened
   * to be captured — "runs whenever, reads the latest", the same pattern `latestControls` uses in
   * the session for the lock-screen intents.
   */
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  });

  const conversation = useConversation({
    onConnect: ({ conversationId }) => eventsRef.current.onTransportId(conversationId),
    onMessage: ({ message, role }) => eventsRef.current.onTurn({ role, text: message }),
    /**
     * Barge-in. Without this the record claims the teacher finished sentences the learner cut off —
     * in an app whose whole premise is interrupting freely.
     */
    onAgentResponseCorrection: ({ original_agent_response, corrected_agent_response }) =>
      eventsRef.current.onTurnCorrected(original_agent_response, corrected_agent_response),
    onStatusChange: ({ status }) => eventsRef.current.onStatus(status),
    onDisconnect: (details) => eventsRef.current.onEnd(details.reason),
    /**
     * The SDK triggers the OS microphone prompt itself from `AudioSession.configureAudio()`, so a
     * DENIED microphone arrives here — as does everything else, which is why `context` is not
     * dropped: it carries the `error_event`'s `errorType` / `code` / `debugMessage` straight off the
     * wire. `tutorErrorMessage` owns the wording and the branching, and it stays in this file
     * because what it knows is what an exhausted ELEVENLABS quota looks like.
     */
    onError: (message, context) => eventsRef.current.onError(tutorErrorMessage(message, context)),
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

  /**
   * Everything the controls below need, refreshed every render and read at call time.
   *
   * This exists so `controls` can be memoised on `[]` — a **permanently** stable object, which
   * `TutorTransportControls` requires and which screens depend on through
   * `useTutorControls()`. Depending on the SDK's own function identities instead would make that
   * stability a bet on `useConversation` internals; this makes it a fact about this file.
   */
  const latest = useRef({
    accessToken,
    startSession,
    endSession,
    sendUserMessage,
    sendContextualUpdate,
    sendUserActivity,
    setMuted,
    rawConversation,
  });
  useEffect(() => {
    latest.current = {
      accessToken,
      startSession,
      endSession,
      sendUserMessage,
      sendContextualUpdate,
      sendUserActivity,
      setMuted,
      rawConversation,
    };
  });

  const controls = useMemo<TutorTransportControls>(
    () => ({
      capabilities: CAPABILITIES,

      start: async (request, onIdentified) => {
        // No microphone pre-flight: the SDK's audio session raises the prompt itself, so a denial
        // arrives through `onError` rather than here.
        const res = await apiFetch<unknown>(
          conversationTokenPath(request.version ?? undefined),
          latest.current.accessToken,
          { method: "POST" },
        );
        if (!isConversationTokenResponse(res)) {
          throw new Error("The server did not return a usable conversation token.");
        }

        // The seam. Everything the session must do while the row key is known and the line is not
        // yet up happens in here — see `TutorTransportControls.start` for the three things and why
        // each is fatal on the other side of the connect.
        await onIdentified({ conversationId: res.conversationId, version: res.version });

        latest.current.startSession({
          conversationToken: res.token,
          connectionType: "webrtc", // the only transport the RN SDK supports; websocket throws
          // The screen is never held awake (D40): S1 proved a locked session keeps talking, and the
          // web's wake lock was an apology for a browser limitation that does not exist here.
          useWakeLock: false,
          dynamicVariables: {
            // How the words reach the agent is this adapter's business: ElevenLabs injects them as
            // a dynamic variable, OpenAI has none and interpolates the same string server-side.
            items_list: formatItemsList(request.items),
            // Ties the post-call webhook payload back to this lesson's history.
            lesson_id: request.lessonId,
            // Required, never defaulted: the webhook routes on it, and a missing one would file
            // this session under the wrong environment.
            app_env: res.appEnv,
          },
        });
      },

      end: () => latest.current.endSession(),
      say: (text) => latest.current.sendUserMessage(text),
      context: (text) => latest.current.sendContextualUpdate(text),
      // Not reachable: `capabilities.cancelTurn` is false and the session checks it. Throwing rather
      // than no-op'ing, because a silent no-op here is precisely the failure the capability flags
      // exist to prevent — if this ever runs, the session stopped asking and that is a bug.
      cancelTurn: () => {
        throw new Error("ElevenLabs cannot cancel a turn — check capabilities.cancelTurn.");
      },
      keepAlive: () => latest.current.sendUserActivity(),
      setMicMuted: (muted) => latest.current.setMuted(muted),
      setOutputSilenced: (silenced) =>
        setAgentAudioVolume(latest.current.rawConversation, silenced ? 0 : 1) > 0,
    }),
    [],
  );

  const state = useMemo(() => ({ status, isSpeaking, isMuted }), [status, isSpeaking, isMuted]);

  return useMemo(() => ({ state, controls }), [state, controls]);
}
