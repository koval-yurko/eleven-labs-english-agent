import { MediaStreamTrack, RTCPeerConnection, mediaDevices } from "@livekit/react-native-webrtc";
import { API_V2_ROUTES, isRealtimeTokenResponse, type RealtimeTokenRequest } from "@tutor/shared/api";
import type {
  TutorCapabilities,
  TutorEndReason,
  TutorStatus,
  TutorUsage,
  TutorTransport,
  TutorTransportControls,
  TutorTransportEvents,
} from "@tutor/shared/tutor-transport";
import { useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "@/api";
import { applyVoiceLessonCategory, ensureStarted, release } from "@/lib/audio-session";
import { useAccessToken } from "@/lib/auth";

/**
 * The OpenAI Realtime transport, over WebRTC.
 *
 * Hand-rolled, because there is no SDK to use: `@openai/agents-realtime` assumes Node or a browser
 * and does not work in React Native (openai/agents-js#133). What makes that ~250 lines instead of a
 * native module is that the app already ships the whole WebRTC stack — importing
 * `@elevenlabs/react-native` runs LiveKit's `registerGlobals()`, and the classes are imported HERE
 * directly from `@livekit/react-native-webrtc` rather than off `global`, so TypeScript can see them
 * and this file does not depend on another module's side effect.
 *
 * Every non-obvious decision below was settled on a device by the stage-0 spike; see §14 of
 * docs/2026-08-22-openai-realtime-second-provider.md. Three are worth knowing before reading:
 *
 *   1. **The audio session must be asserted by this file, twice** (§4.1). Nothing else can: the
 *      moments that matter are "local track open" and "remote track arrived", both before the
 *      connection ever reports connected.
 *   2. **A corrected transcript has to be ASKED for** (§6.1). The server trims the item to what was
 *      actually heard, but tells nobody — `conversation.item.truncated` then
 *      `conversation.item.retrieve` is the round trip that ElevenLabs delivers as a callback.
 *   3. **The end reason is synthesised** (§6.2). OpenAI has no "the far end hung up on purpose"
 *      signal, so this file keeps a flag over its own `end()` and calls the rest a failure.
 */

/**
 * What this provider can do, measured rather than hoped.
 *
 * The two that differ from ElevenLabs are the two that were worth building it for. `cancelTurn`
 * means a held pause stops the tutor with `response.cancel` instead of spending a turn on a fake
 * user message; `userActivity: false` means a held pause runs no timer at all, because with VAD on
 * and nobody talking the model simply waits.
 */
const CAPABILITIES: TutorCapabilities = {
  // A real native gain control on the remote track, handed to us by the `track` event. No reaching
  // through a `protected` field, and no "did it actually work" doubt — but the signature still
  // reports it, because a track that has not arrived yet cannot be silenced.
  silenceOutput: true,
  userActivity: false,
  cancelTurn: true,
  responseCorrection: true,
};

/** Everything the model sends arrives as one of these. Fields are read defensively, never trusted. */
type ServerEvent = Record<string, unknown> & { type?: string };

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * `response.done`'s usage block → the shared shape.
 *
 * Read defensively field by field rather than cast, because this is the ONLY witness to what a
 * lesson cost: OpenAI has no post-call webhook and no post-call transcript endpoint, so a shape
 * change here would silently zero the cost record instead of failing.
 */
function toUsage(raw: unknown): TutorUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const input = u.input_token_details as Record<string, unknown> | undefined;
  const output = u.output_token_details as Record<string, unknown> | undefined;
  const usage: TutorUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    inputAudioTokens: num(input?.audio_tokens),
    outputAudioTokens: num(output?.audio_tokens),
    cachedInputTokens: num(input?.cached_tokens),
  };
  // A response that reported nothing is not worth an event; summing zeroes only adds noise.
  return usage.inputTokens === 0 && usage.outputTokens === 0 ? null : usage;
}

/** `pc.connectionState` → the vocabulary the session branches on. */
function toStatus(state: string): TutorStatus {
  if (state === "connected") return "connected";
  if (state === "new" || state === "connecting") return "connecting";
  if (state === "failed") return "error";
  return "disconnected";
}

export function useOpenAiTransport(events: TutorTransportEvents): TutorTransport {
  const accessToken = useAccessToken();

  const [status, setStatus] = useState<TutorStatus>("disconnected");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<ReturnType<RTCPeerConnection["createDataChannel"]> | null>(null);
  const localRef = useRef<MediaStreamTrack | null>(null);
  const remoteRef = useRef<MediaStreamTrack | null>(null);
  /**
   * Did WE hang up? The whole of this provider's answer to `TutorEndReason` (§6.2).
   *
   * ElevenLabs reports `"user" | "agent" | "error"` off the wire and the session's comment says the
   * reason is *"read rather than inferred"*. That stops being true here and the difference is
   * absorbed in this file rather than leaking: a teardown we asked for is `"user"`, a peer
   * connection that reached `failed` is `"error"`, and a line that closed on its own is `"agent"` —
   * which on this provider most often means the 60-minute session ceiling.
   */
  const hangingUpRef = useRef(false);
  /** `onEnd` fires exactly once per session: `close()` can produce several state transitions. */
  const endedRef = useRef(true);
  /**
   * What the model has GENERATED per item, accumulated from the transcript deltas.
   *
   * The measuring stick for a barge-in. `conversation.item.truncated` names an item and an
   * `audio_end_ms` but carries no text, so the correction is `generated` (here) against `retained`
   * (fetched) — and both halves are needed to raise `onTurnCorrected`.
   */
  const generatedRef = useRef<Map<string, string>>(new Map());

  const eventsRef = useRef(events);
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    eventsRef.current = events;
    tokenRef.current = accessToken;
  });

  /**
   * Everything below is built once, on `[]`, and reads through refs.
   *
   * `TutorTransportControls` REQUIRES a permanently stable identity — screens put the session's
   * controls in effect dependency arrays on the strength of it. Doing it with refs makes that
   * stability a fact about this file rather than a bet on anything else.
   */
  const live = useRef({
    /** Send one client event. Returns whether it went — a closed channel is not an exception. */
    send(event: Record<string, unknown>): boolean {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") return false;
      dc.send(JSON.stringify(event));
      return true;
    },
    /** Tear everything down and report why, exactly once. */
    teardown(reason: TutorEndReason) {
      if (endedRef.current) return;
      endedRef.current = true;
      dcRef.current?.close();
      dcRef.current = null;
      localRef.current?.stop();
      localRef.current = null;
      remoteRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
      generatedRef.current.clear();
      hangingUpRef.current = false;
      // We started the session, so we stop it. The ElevenLabs adapter must never do this — its SDK
      // already does, globally — but nothing stops this one on our behalf. See `lib/audio-session`.
      void release();
      setStatus("disconnected");
      setIsSpeaking(false);
      setIsMuted(false);
      eventsRef.current.onStatus("disconnected");
      eventsRef.current.onEnd(reason);
    },
    handle(event: ServerEvent) {
      const type = event.type ?? "";
      const emit = eventsRef.current;

      switch (type) {
        // ── the transcript, both halves ──────────────────────────────────────────────────────
        case "conversation.item.input_audio_transcription.completed": {
          const text = str(event.transcript);
          if (text) emit.onTurn({ role: "user", text });
          return;
        }
        case "response.output_audio_transcript.delta": {
          const id = str(event.item_id);
          const delta = str(event.delta);
          if (id && delta) {
            generatedRef.current.set(id, (generatedRef.current.get(id) ?? "") + delta);
          }
          return;
        }
        case "response.output_audio_transcript.done": {
          const text = str(event.transcript);
          if (text) emit.onTurn({ role: "agent", text });
          return;
        }

        // ── barge-in, in two events, because the correction has to be fetched ────────────────
        case "conversation.item.truncated": {
          const id = str(event.item_id);
          if (id) live.current.send({ type: "conversation.item.retrieve", item_id: id });
          return;
        }
        case "conversation.item.retrieved": {
          const item = event.item as { id?: string; content?: unknown[] } | undefined;
          const id = str(item?.id);
          if (!id) return;
          const generated = generatedRef.current.get(id);
          const retained = (item?.content ?? [])
            .map((c) => str((c as { transcript?: unknown } | null)?.transcript) ?? "")
            .join("");
          // Only a real correction is reported. Equal texts mean nothing was cut; an EMPTY retained
          // text means the whole turn went unheard, and rewriting the stored line to "" would delete
          // a turn the learner did partly hear rather than correct it.
          if (!generated || !retained || retained === generated) return;
          generatedRef.current.set(id, retained);
          emit.onTurnCorrected(generated, retained);
          return;
        }

        // ── is the tutor talking (WebRTC-only events) ────────────────────────────────────────
        case "output_audio_buffer.started":
          setIsSpeaking(true);
          return;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          setIsSpeaking(false);
          return;

        case "response.done": {
          const response = event.response as { usage?: unknown } | undefined;
          const usage = toUsage(response?.usage);
          if (usage) emit.onUsage(usage);
          return;
        }

        case "error": {
          const detail = event.error as { message?: unknown; code?: unknown } | undefined;
          const message = str(detail?.message) ?? "The tutor service reported an error.";
          const code = str(detail?.code);
          // The OpenAI half of what `tutorErrorMessage` does for ElevenLabs: this provider's own
          // vocabulary, worded here, because a shared branch would be right for one and misleading
          // for the other.
          emit.onError(
            code === "insufficient_quota"
              ? `${message} — the tutor account is out of OpenAI credit. Lessons will work again once it is topped up; nothing on this phone needs fixing.`
              : `${message}${code ? ` (${code})` : ""}`,
          );
          return;
        }

        default:
          return;
      }
    },
  });

  const controls = useMemo<TutorTransportControls>(
    () => ({
      capabilities: CAPABILITIES,

      start: async (request, onIdentified) => {
        const body: RealtimeTokenRequest = {
          lessonId: request.lessonId,
          // Interpolated into `session.instructions` server-side: this provider has no dynamic
          // variables, so the words travel as data and the prompt never reaches the app.
          items: request.items,
          ...(request.version ? { version: request.version } : {}),
        };
        const res = await apiFetch<unknown>(API_V2_ROUTES.realtimeToken, tokenRef.current, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!isRealtimeTokenResponse(res)) {
          throw new Error("The server did not return a usable realtime credential.");
        }

        // The seam — see `TutorTransportControls.start`. Nothing below may run before it, because a
        // turn can arrive on the first frame after the connect and needs a row key to file under.
        await onIdentified({ conversationId: res.conversationId, version: res.version });

        endedRef.current = false;
        hangingUpRef.current = false;
        setStatus("connecting");
        eventsRef.current.onStatus("connecting");

        try {
          // §4.1. Without this AVAudioSession stays in `soloAmbient`, which cannot render a WebRTC
          // audio unit: every event flows, the transcript fills in, and the lesson is SILENT.
          await ensureStarted();

          const stream = await mediaDevices.getUserMedia({ audio: true });
          const local = stream.getAudioTracks()[0];
          if (!local) throw new Error("The microphone returned no audio track.");
          localRef.current = local;
          // Again, now that a local track exists — the category is asserted per track-state change,
          // which is what LiveKit does for its own Room and what nothing does for ours.
          await applyVoiceLessonCategory();

          const pc = new RTCPeerConnection({
            // Belt and braces: OpenAI answers from a public address, so host candidates plus the
            // peer-reflexive one it learns from our first binding request are enough.
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          });
          pcRef.current = pc;

          pc.addEventListener("connectionstatechange", () => {
            const next = toStatus(pc.connectionState);
            setStatus(next);
            eventsRef.current.onStatus(next);
            if (next !== "error" && next !== "disconnected") return;
            live.current.teardown(
              hangingUpRef.current ? "user" : next === "error" ? "error" : "agent",
            );
          });

          pc.addEventListener("track", (event) => {
            if (!event.track) return;
            remoteRef.current = event.track;
            // The third assertion, and the one stage 0 proved was load-bearing: the WebRTC audio
            // unit reconfigures the session as it starts, and iOS resets the category on some route
            // changes.
            void applyVoiceLessonCategory();
          });

          const dc = pc.createDataChannel("oai-events");
          dcRef.current = dc;
          dc.addEventListener("message", (event) => {
            try {
              live.current.handle(JSON.parse(String(event.data)) as ServerEvent);
            } catch {
              // A malformed frame is not worth ending a lesson over, and there is nothing useful to
              // tell the learner about one.
            }
          });

          pc.addTrack(local, stream);

          const offer = await pc.createOffer({});
          await pc.setLocalDescription(offer);
          // Posted WITHOUT waiting for ICE gathering, which is what OpenAI's own example does: the
          // answer carries their candidates and they learn ours peer-reflexively. There is nowhere
          // to trickle to over a one-shot HTTP exchange anyway.
          const sdp = await fetch("https://api.openai.com/v1/realtime/calls", {
            method: "POST",
            headers: {
              // The EPHEMERAL key. The account key never leaves the web backend.
              authorization: `Bearer ${res.clientSecret}`,
              "content-type": "application/sdp",
            },
            body: pc.localDescription?.sdp ?? offer.sdp,
          });
          if (!sdp.ok) {
            throw new Error(`The tutor service refused the connection (HTTP ${sdp.status}).`);
          }
          // ADVISORY ONLY, exactly like the ElevenLabs room id: compared against the authoritative
          // conversation id, never stored. It is also the handle a server-side sideband connection
          // would need (§9), which is why it is surfaced rather than dropped.
          const callId = sdp.headers.get("location")?.split("/").pop();
          if (callId) eventsRef.current.onTransportId(callId);

          await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
        } catch (e) {
          // The line never came up, so this is a FAILED START and not a session that ended: tear the
          // half-built connection down without raising `onEnd`, and let `start`'s caller report it.
          endedRef.current = true;
          dcRef.current?.close();
          dcRef.current = null;
          localRef.current?.stop();
          localRef.current = null;
          pcRef.current?.close();
          pcRef.current = null;
          void release();
          setStatus("disconnected");
          eventsRef.current.onStatus("disconnected");
          throw e;
        }
      },

      end: () => {
        if (endedRef.current) return;
        hangingUpRef.current = true;
        setStatus("disconnecting");
        eventsRef.current.onStatus("disconnecting");
        // Synchronous, and the teardown is taken here rather than left to the state change: closing
        // a peer connection does not reliably produce one, and a session that never reports its end
        // never gets its transcript saved.
        live.current.teardown("user");
      },

      say: (text) => {
        live.current.send({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        });
        live.current.send({ type: "response.create" });
      },

      /**
       * Context WITHOUT provoking a turn — `sendContextualUpdate`'s analogue.
       *
       * A `system` item rather than a `user` one: this is information FOR the tutor, not something
       * the learner said, and filing it as a user turn would put words in their mouth in a
       * transcript the app stores. System items accept `input_text` only, which is all this needs.
       * No `response.create` follows, which is what makes it silent.
       */
      context: (text) => {
        live.current.send({
          type: "conversation.item.create",
          item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
        });
      },

      cancelTurn: () => {
        live.current.send({ type: "response.cancel" });
        // The server holds the played-audio buffer on WebRTC, so this is what actually stops the
        // sound — and it is what makes the truncation (and therefore the correction) happen.
        live.current.send({ type: "output_audio_buffer.clear" });
      },

      // Nothing to do: `capabilities.userActivity` is false, so the session never schedules the
      // timer that would call this. Present and empty rather than throwing, because unlike
      // `cancelTurn` a keep-alive that does nothing is CORRECT here, not a bug.
      keepAlive: () => {},

      setMicMuted: (muted) => {
        const track = localRef.current;
        if (!track) return;
        track.enabled = !muted;
        setIsMuted(muted);
      },

      setOutputSilenced: (silenced) => {
        const track = remoteRef.current;
        if (!track) return false;
        try {
          track._setVolume(silenced ? 0 : 1);
          return true;
        } catch {
          // Same rule as the ElevenLabs path: report the failure so a pause cannot claim a silence
          // it did not deliver.
          return false;
        }
      },
    }),
    [],
  );

  const state = useMemo(() => ({ status, isSpeaking, isMuted }), [status, isSpeaking, isMuted]);
  return useMemo(() => ({ state, controls }), [state, controls]);
}
