import { AudioSession, getDefaultAppleAudioConfigurationForMode } from "@livekit/react-native";
import { MediaStreamTrack, RTCPeerConnection, mediaDevices } from "@livekit/react-native-webrtc";
import { API_V2_ROUTES, isRealtimeSpikeTokenResponse } from "@tutor/shared/api";
import { Link } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiFetch } from "@/api";
import { useEventLog } from "@/hooks/use-event-log";
import { useAccessToken } from "@/lib/auth";
import { useTheme, type Palette } from "@/theme";

/**
 * `/realtime` — **STAGE 0 SPIKE.** A throwaway instrument, not a feature.
 *
 * Its only job is to answer, on a real device, the five questions in
 * docs/2026-08-22-openai-realtime-second-provider.md §12, before any abstraction is written:
 *
 *   1. does remote audio play, with echo cancellation, on the AudioSession we already configure?
 *   2. **does it survive a screen lock** — the entire reason `apps/mobile` exists (S1)?
 *   3. what exactly arrives on barge-in: is there a corrected transcript, or none? (§6.1)
 *   4. does `_setVolume(0)` silence the remote track, the way `agent-audio.ts` wishes it could?
 *   5. what does semantic VAD do to pacing?
 *
 * Nothing here is reused by `lib/tutor-session.tsx` and nothing here should be: the whole argument
 * of §12 is that an interface written before the second implementation exists comes out
 * ElevenLabs-shaped with OpenAI-shaped holes. This file is what stops that. It is expected to be
 * DELETED when stage 1 begins.
 *
 * ## Why it is hand-rolled
 *
 * There is no SDK to use. `@openai/agents-realtime` does not work in React Native
 * (openai/agents-js#133) — it assumes Node or a browser. What makes this ~200 lines rather than a
 * native module is that the app already ships the whole WebRTC stack: importing
 * `@elevenlabs/react-native` in `_layout.tsx` runs LiveKit's `registerGlobals()`, and the classes
 * are imported HERE directly from `@livekit/react-native-webrtc` rather than off `global`, so
 * TypeScript can see them and this screen does not depend on another module's side effect
 * (the mistake `lib/ids.ts` documents).
 *
 * ## How to read a run
 *
 * The scrollback is S1's (`hooks/use-event-log`), newest first, wall-clock stamped, for the same
 * reason: after a lock test you want the gap and what followed it at the top of the screen. The
 * `alive` heartbeat every 5 s is the proof for question 2 — an unbroken run of timestamps across the
 * window you had the phone locked means the runtime was never suspended.
 */

/** Everything the model sends arrives here as one of these. Fields are read defensively. */
type ServerEvent = Record<string, unknown> & { type?: string };

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Deltas and per-token chatter. Logged as nothing — they would bury the four events that matter. */
const MUTED_EVENTS = new Set([
  "response.output_audio_transcript.delta",
  "response.output_audio.delta",
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "rate_limits.updated",
]);

/**
 * Put AVAudioSession into the category a WebRTC voice call needs, and say so in the log.
 *
 * ## The bug this exists for
 *
 * The first run of this spike produced a perfect event stream and **total silence**: the transcript
 * arrived, `output_audio_buffer.started` fired, and nothing came out of the phone. It worked only
 * after an ElevenLabs lesson had been started first — which is the whole diagnosis.
 *
 * `AudioSession.configureAudio()` and `startAudioSession()` do NOT set the Apple category or mode.
 * That is done by `useIOSAudioManagement`, which watches a LiveKit **Room**'s track state and
 * applies `getDefaultAppleAudioConfigurationForMode(state)` as tracks come and go. Its table is:
 *
 *     'none'                       → soloAmbient  / default     ← cannot render a WebRTC audio unit
 *     'remoteOnly'                 → playback     / spokenAudio
 *     'localOnly' | 'localAndRemote' → playAndRecord / videoChat
 *
 * A raw `RTCPeerConnection` has no Room, so nothing ever moves the session off `soloAmbient`. An
 * ElevenLabs lesson moves it to `playAndRecord` and LEAVES it there, which is why running one first
 * made the OpenAI session audible — the spike was free-riding on the other provider's setup.
 *
 * ## Why it is re-applied rather than set once
 *
 * The WebRTC audio unit reconfigures the session itself when it starts, and iOS resets the category
 * on some route changes. LiveKit's answer is to re-apply on every track-state change; this is the
 * same answer with two states — local track open, then remote track arrived.
 *
 * ## What this means beyond the spike
 *
 * **AVAudioSession is one process-wide resource that no provider can own privately.** Whichever
 * adapter configures it last wins, so a two-provider app cannot leave this inside the adapters —
 * see docs/2026-08-22-openai-realtime-second-provider.md §7.
 */
async function applyVoiceChatAudio(
  log: (kind: "status" | "error", text: string) => void,
  when: string,
): Promise<void> {
  // `preferSpeakerOutput: true` → mode `videoChat`, which defaults the route to the speaker. That is
  // what a tutor lesson wants and what the ElevenLabs path already produces.
  const config = getDefaultAppleAudioConfigurationForMode("localAndRemote", true);
  try {
    await AudioSession.setAppleAudioConfiguration(config);
    log("status", `audio category → ${config.audioCategory}/${config.audioMode} (${when})`);
  } catch (e) {
    log("error", `setAppleAudioConfiguration failed (${when}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The kickoff, which exists here for the same reason `KICKOFF_MESSAGE` exists in
 * `@tutor/shared/tutor`: an agent with no first message waits, and a user turn is what reliably
 * makes it open the lesson. NOT imported from shared — the shared constant is worded for the
 * ElevenLabs agent, and borrowing it would quietly make this spike a test of that wording.
 */
const SPIKE_KICKOFF = "Let's begin. Greet me in one sentence and teach the first word now.";

export default function RealtimeSpikeScreen() {
  const accessToken = useAccessToken();
  const { entries, log, clear } = useEventLog();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const kindStyles = useMemo(() => makeKindStyles(theme), [theme]);

  const [status, setStatus] = useState("idle");
  const [model, setModel] = useState("—");
  const [callId, setCallId] = useState("—");
  const [muted, setMuted] = useState(false);
  const [silenced, setSilenced] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<ReturnType<RTCPeerConnection["createDataChannel"]> | null>(null);
  const localRef = useRef<MediaStreamTrack | null>(null);
  const remoteRef = useRef<MediaStreamTrack | null>(null);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * What the model has GENERATED per item, accumulated from the deltas we otherwise drop.
   *
   * This is the measuring stick for question 3: on a barge-in, compare what was generated against
   * what the server still holds after truncation. The docs say truncating "will delete the
   * server-side text transcript"; if that is literal, there is no corrected transcript to be had and
   * §6.1's fallback is the only option. This screen is how that stops being a reading of the docs.
   */
  const generatedRef = useRef<Map<string, string>>(new Map());

  const send = useCallback(
    (event: Record<string, unknown>) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") {
        log("error", `cannot send ${String(event.type)} — data channel is ${dc?.readyState ?? "absent"}`);
        return;
      }
      dc.send(JSON.stringify(event));
      log("note", `→ ${String(event.type)}`);
    },
    [log],
  );

  const onServerEvent = useCallback(
    (event: ServerEvent) => {
      const type = event.type ?? "(untyped)";
      if (MUTED_EVENTS.has(type)) {
        // Silent, except for the one thing a delta is good for: reconstructing what was generated.
        if (type === "response.output_audio_transcript.delta") {
          const id = str(event.item_id);
          const delta = str(event.delta);
          if (id && delta) generatedRef.current.set(id, (generatedRef.current.get(id) ?? "") + delta);
        }
        return;
      }

      switch (type) {
        case "session.created":
        case "session.updated": {
          const session = event.session as { model?: string } | undefined;
          if (session?.model) setModel(session.model);
          log("status", `${type} · ${session?.model ?? "?"}`);
          return;
        }

        // ── the transcript, both halves ────────────────────────────────────────────────────────
        case "conversation.item.input_audio_transcription.completed":
          log("you", str(event.transcript) ?? "(empty)");
          return;
        case "conversation.item.input_audio_transcription.failed":
          log("error", `learner transcription failed: ${JSON.stringify(event.error ?? {})}`);
          return;
        case "response.output_audio_transcript.done":
          log("agent", str(event.transcript) ?? "(empty)");
          return;

        // ── barge-in: question 3 ───────────────────────────────────────────────────────────────
        case "input_audio_buffer.speech_started":
          log("appstate", "learner speech ↑ (VAD)");
          return;
        case "input_audio_buffer.speech_stopped":
          log("appstate", "learner speech ↓ (VAD)");
          return;
        case "output_audio_buffer.cleared": {
          // WebRTC-only, and the direct evidence that the server cut its own playback short.
          log("appstate", "output buffer CLEARED — the tutor was cut off");
          return;
        }
        case "conversation.item.truncated": {
          const id = str(event.item_id);
          log(
            "appstate",
            `TRUNCATED item=${id ?? "?"} audio_end_ms=${String(event.audio_end_ms ?? "?")}`,
          );
          if (!id) return;
          log("note", `generated: "${(generatedRef.current.get(id) ?? "").slice(0, 300)}"`);
          // Ask what the server still holds. The answer is the whole of question 3: a trimmed
          // transcript means parity with `onAgentResponseCorrection`; an empty one means §6.1's
          // fallback (trim our own line proportionally) is the only option, and it is a guess.
          send({ type: "conversation.item.retrieve", item_id: id });
          return;
        }
        case "conversation.item.retrieved": {
          const item = event.item as { id?: string; content?: unknown[] } | undefined;
          const transcript = (item?.content ?? [])
            .map((c) => str((c as { transcript?: unknown } | null)?.transcript) ?? "")
            .join("");
          log(
            transcript ? "you" : "error",
            `retained after truncation: "${transcript.slice(0, 300)}"${transcript ? "" : "  ← EMPTY: no corrected transcript exists"}`,
          );
          return;
        }

        // ── turn lifecycle ────────────────────────────────────────────────────────────────────
        case "output_audio_buffer.started":
          log("status", "tutor speaking");
          return;
        case "output_audio_buffer.stopped":
          log("status", "tutor stopped");
          return;
        case "response.done": {
          const response = event.response as
            | { status?: string; usage?: Record<string, unknown> }
            | undefined;
          // Usage is logged because §10's cost model is currently arithmetic, not measurement, and
          // a real lesson-shaped turn is the cheapest correction to it available.
          log(
            "status",
            `response.done ${response?.status ?? "?"} · usage ${JSON.stringify(response?.usage ?? {})}`.slice(
              0,
              300,
            ),
          );
          return;
        }

        case "error":
          log("error", JSON.stringify(event.error ?? event).slice(0, 400));
          return;

        default:
          // Type only, no payload: an unrecognised event is worth knowing about, but a spike whose
          // scrollback is unreadable answers nothing.
          log("note", `← ${type}`);
      }
    },
    [log, send],
  );

  const teardown = useCallback(
    (why: string) => {
      if (beatRef.current !== null) {
        clearInterval(beatRef.current);
        beatRef.current = null;
      }
      dcRef.current?.close();
      dcRef.current = null;
      localRef.current?.stop();
      localRef.current = null;
      remoteRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
      generatedRef.current.clear();
      void AudioSession.stopAudioSession();
      setStatus("closed");
      setCallId("—");
      setMuted(false);
      setSilenced(false);
      log("status", `closed — ${why}`);
    },
    [log],
  );

  const connect = useCallback(async () => {
    if (pcRef.current) return log("error", "already connected — disconnect first");
    try {
      setStatus("minting");
      log("note", `POST ${API_V2_ROUTES.realtimeSpikeToken}`);
      const res = await apiFetch<unknown>(API_V2_ROUTES.realtimeSpikeToken, accessToken, {
        method: "POST",
      });
      if (!isRealtimeSpikeTokenResponse(res)) {
        setStatus("failed");
        return log("error", `unrecognised token body: ${JSON.stringify(res).slice(0, 200)}`);
      }
      setModel(res.model);
      log("status", `client secret ok · ${res.model} · expires ${res.expiresAt}`);

      // ── audio, before anything opens the microphone ────────────────────────────────────────
      // The same two calls the ElevenLabs SDK makes for us. Question 1 and question 2 both live
      // here: this is what puts AVAudioSession in a play-and-record voice-chat category, which is
      // what gives us echo cancellation AND what keeps iOS from suspending the app on lock (S1).
      await AudioSession.configureAudio({ ios: { defaultOutput: "speaker" } });
      await AudioSession.startAudioSession();
      log("status", "audio session started");

      const stream = await mediaDevices.getUserMedia({ audio: true });
      const local = stream.getAudioTracks()[0];
      if (!local) throw new Error("getUserMedia returned no audio track");
      localRef.current = local;
      log("status", "microphone open");
      await applyVoiceChatAudio(log, "local track");

      // ── the peer connection ────────────────────────────────────────────────────────────────
      // A STUN server is belt-and-braces: OpenAI's endpoint is on a public address, so host
      // candidates plus the peer-reflexive one it learns from our first binding request are enough.
      // If ICE ever fails on a hostile network, this line is the first thing to widen.
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      pc.addEventListener("connectionstatechange", () => {
        const state = pc.connectionState;
        setStatus(state);
        log(state === "failed" ? "error" : "status", `pc ${state}`);
        if (state === "failed" || state === "closed") teardown(`peer connection ${state}`);
      });

      /**
       * The remote track. On React Native there is no `<audio>` element and none is needed —
       * playback is automatic — so the only reason to hold it is question 4: `_setVolume` is a
       * custom method on this fork's `MediaStreamTrack` that reaches a real native gain control on
       * REMOTE tracks. It is what `lib/agent-audio.ts` currently reaches three levels through a
       * `protected` field to find.
       */
      pc.addEventListener("track", (event) => {
        // Typed nullable by the fork, so it is checked rather than asserted: a `track` event with no
        // track means there is nothing to silence later, and question 4 would fail with a null
        // dereference instead of an answer.
        if (!event.track) return log("error", "track event carried no track");
        remoteRef.current = event.track;
        log("status", `remote ${event.track.kind} track — playback is automatic`);
        // The WebRTC audio unit has just started and may have moved the session under us.
        void applyVoiceChatAudio(log, "remote track");
      });

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("open", () => log("status", "oai-events open"));
      dc.addEventListener("close", () => log("status", "oai-events closed"));
      dc.addEventListener("message", (event) => {
        try {
          onServerEvent(JSON.parse(String(event.data)) as ServerEvent);
        } catch {
          log("error", `unparseable event: ${String(event.data).slice(0, 200)}`);
        }
      });

      pc.addTrack(local, stream);

      // ── SDP exchange ───────────────────────────────────────────────────────────────────────
      setStatus("connecting");
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      // Posted WITHOUT waiting for ICE gathering, which is what OpenAI's own example does: the
      // answer carries their candidates, and they learn ours peer-reflexively from the first
      // binding request. There is nowhere to trickle to over a one-shot HTTP exchange anyway.
      const sdp = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          // The EPHEMERAL key, never the account key — that one never leaves the web backend.
          authorization: `Bearer ${res.clientSecret}`,
          "content-type": "application/sdp",
        },
        body: pc.localDescription?.sdp ?? offer.sdp,
      });
      if (!sdp.ok) {
        throw new Error(`SDP exchange HTTP ${sdp.status}: ${(await sdp.text()).slice(0, 300)}`);
      }
      // The call id, which is the only handle a server-side sideband connection could ever use
      // (§9). Nothing here opens one — it is logged so stage 5 knows it is really there.
      const id = sdp.headers.get("location")?.split("/").pop() ?? null;
      setCallId(id ?? "(no Location header)");
      log(id ? "status" : "error", `call id: ${id ?? "MISSING — no Location header"}`);

      await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
      log("status", "answer applied — waiting for the line to come up");

      // The proof for question 2. Wall-clock, every 5 s: an unbroken run across the window the
      // phone was locked means the runtime was never suspended.
      beatRef.current = setInterval(() => log("note", `alive · ${pc.connectionState}`), 5_000);
    } catch (e) {
      setStatus("failed");
      log("error", e instanceof Error ? e.message : String(e));
      teardown("connect failed");
    }
  }, [accessToken, log, onServerEvent, teardown]);

  // ── controls ───────────────────────────────────────────────────────────────────────────────

  /** The kickoff: create a user turn, then ask for a response. Two events, unlike `sendUserMessage`. */
  const kickoff = useCallback(() => {
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: SPIKE_KICKOFF }],
      },
    });
    send({ type: "response.create" });
  }, [send]);

  /**
   * Stop the tutor mid-turn without spending a turn — §11.2. The held pause does this today by
   * sending a fake user message, which costs a turn and has to be filtered back out of the
   * transcript; here it is two first-class events and no transcript pollution.
   */
  const cancelTurn = useCallback(() => {
    send({ type: "response.cancel" });
    send({ type: "output_audio_buffer.clear" });
  }, [send]);

  const toggleMute = useCallback(() => {
    const track = localRef.current;
    if (!track) return log("error", "no microphone track");
    const next = !muted;
    track.enabled = !next;
    setMuted(next);
    log("status", `microphone ${next ? "muted" : "live"}`);
  }, [muted, log]);

  /** Question 4, and the reason `lib/agent-audio.ts` reports how many tracks it reached. */
  const toggleSilence = useCallback(() => {
    const track = remoteRef.current;
    if (!track) return log("error", "no remote track — cannot silence, and saying so is the point");
    const next = !silenced;
    try {
      track._setVolume(next ? 0 : 1);
      setSilenced(next);
      log("status", `tutor ${next ? "SILENCED" : "audible"} via _setVolume`);
    } catch (e) {
      log("error", `_setVolume threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [silenced, log]);

  // Background / foreground, with the log kind S1 added for exactly this.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => log("appstate", `AppState → ${next}`));
    return () => sub.remove();
  }, [log]);

  // This screen owns a live, billed connection, and unlike the tutor session it is NOT meant to
  // survive navigation — it is an instrument, and leaving it should put it down.
  const teardownRef = useRef(teardown);
  useEffect(() => {
    teardownRef.current = teardown;
  });
  useEffect(() => () => teardownRef.current("screen unmounted"), []);

  // Derived from STATE, not from `pcRef`: a ref read during render is invisible to React, so the
  // hint below would keep describing the previous connection. `react-hooks/refs` catches this.
  const live = status === "connected";

  return (
    <SafeAreaView style={styles.screen}>
      <Link href="/" style={styles.link}>
        ← home
      </Link>

      <View style={styles.stats}>
        <Stat label="state" value={status} />
        <Stat label="model" value={model} />
        <Stat label="call" value={callId} />
        <Stat label="audio" value={`${muted ? "mic off" : "mic on"} · ${silenced ? "silenced" : "audible"}`} />
      </View>

      <View style={styles.buttons}>
        <Button label="Connect" onPress={() => void connect()} />
        <Button label="Disconnect" onPress={() => teardown("you pressed Disconnect")} />
      </View>
      <View style={styles.buttons}>
        <Button label="Kickoff" onPress={kickoff} />
        <Button label="Cancel turn" onPress={cancelTurn} />
      </View>
      <View style={styles.buttons}>
        <Button label={muted ? "Unmute" : "Mute"} onPress={toggleMute} />
        <Button label={silenced ? "Unsilence" : "Silence"} onPress={toggleSilence} />
        <Button label="Clear log" onPress={clear} />
      </View>

      <Text style={styles.meta}>
        {live
          ? "Interrupt the tutor mid-sentence, then read the TRUNCATED / retained pair below."
          : "Connect, press Kickoff, then talk. Lock the phone for a minute and unlock."}
      </Text>

      <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
        {entries.map((e) => (
          <Text key={e.id} style={[styles.line, kindStyles[e.kind]]}>
            {e.at} {e.text}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

/** Same palette and the same log kinds as `app/auth.tsx` — this is the same instrument, one stage on. */
const makeKindStyles = (t: Palette) =>
  StyleSheet.create({
    you: { color: t.ok, fontWeight: "700" },
    agent: { color: t.text },
    status: { color: t.accent },
    appstate: { color: t.warn },
    error: { color: t.error },
    note: { color: t.muted },
  });

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 16 },
    link: { color: t.accent, fontSize: 12, paddingVertical: 8 },
    stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    stat: { minWidth: "45%", flexGrow: 1, backgroundColor: t.panel, borderRadius: 8, padding: 8 },
    statLabel: { color: t.muted, fontSize: 10 },
    statValue: { color: t.text, fontSize: 14, fontVariant: ["tabular-nums"] },
    meta: { color: t.faint, fontSize: 10, marginTop: 8 },
    buttons: { flexDirection: "row", gap: 8, marginTop: 10 },
    button: { flex: 1, backgroundColor: t.panel, borderRadius: 8, paddingVertical: 12 },
    buttonLabel: { color: t.text, textAlign: "center", fontSize: 14, fontWeight: "600" },
    log: { flex: 1, backgroundColor: t.sunken, borderRadius: 8, marginTop: 12 },
    logContent: { padding: 8, gap: 2 },
    line: { fontSize: 11, fontVariant: ["tabular-nums"] },
  });
