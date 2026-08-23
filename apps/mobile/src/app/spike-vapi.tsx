/**
 * SPIKE ONLY — path A of docs/2026-08-27-vapi-third-voice-provider.md. NEVER MERGE.
 *
 * A working Vapi call, or the precise reason there isn't one.
 *
 * ## What is actually being tested
 *
 * Not "does Vapi work" — Vapi works. The question is whether it works **in this binary**, where
 * `@daily-co/react-native-daily-js` (written against Daily's M118 WebRTC fork) is driving
 * `@livekit/react-native-webrtc` at M137 instead, because that is the only way both providers fit
 * in one app (see `metro.config.js`).
 *
 * Three things can go wrong, in the order you will meet them:
 *
 *   1. **The four missing methods.** Daily's fork adds `setDailyAudioMode` and friends; LiveKit's
 *      has none of them. `lib/spike/daily-webrtc-shim.ts` supplies them. If the shim reports
 *      `REJECTED`, stop — the New Architecture proxy refused the patch and nothing below will work.
 *   2. **M118 JS against M137 native.** Any WebRTC call whose shape changed between those
 *      generations fails here, at runtime. It will show up as a `THREW` line or a `call-start-failed`.
 *   3. **Silence.** The most dangerous outcome, because everything "passes". See the A/B test below.
 *
 * ## The A/B silence test — the part that actually decides it
 *
 * `lib/audio-session.ts` explains why AVAudioSession is the thing to distrust: it is one
 * process-wide resource, and a second owner makes a lesson fail as silence rather than as an error.
 * The OpenAI spike lost a day to exactly this. So a call that connects is not a pass. Run all three,
 * twice each, and every one must be AUDIBLE:
 *
 *   a. cold launch → Start Vapi                                     → audible?
 *   b. cold launch → real ElevenLabs lesson → end it → Start Vapi   → audible?
 *   c. cold launch → Start Vapi → Stop → real ElevenLabs lesson     → audible?
 *
 * (b) and (c) are the ones that matter: they are where two audio-session owners fight. Use a real
 * lesson from the app for the ElevenLabs half — this screen deliberately does not fake one, because
 * a fake would not exercise the SDK's own session setup, which is the thing under suspicion.
 *
 * ## Setup
 *
 * Two env vars in `apps/mobile/.env`, then REBUILD — `EXPO_PUBLIC_*` is inlined at build time:
 *
 *     EXPO_PUBLIC_VAPI_PUBLIC_KEY=...      # Vapi dashboard → API Keys → Public
 *     EXPO_PUBLIC_VAPI_ASSISTANT_ID=...    # Vapi dashboard → your test assistant
 *
 * SPIKE-VAPI.md has the assistant recipe. Reach this screen at `/spike-vapi`.
 */
import Constants from "expo-constants";
import { useCallback, useEffect, useRef, useState } from "react";
import { NativeModules, Pressable, ScrollView, Text, View } from "react-native";

import { applyVoiceLessonCategory, ensureStarted, VOICE_LESSON_CATEGORY } from "@/lib/audio-session";
import { describeShim, installDailyWebRtcShim } from "@/lib/spike/daily-webrtc-shim";

/**
 * Read from the MANIFEST, not from `process.env`.
 *
 * `process.env.EXPO_PUBLIC_*` is inlined by babel-preset-expo at TRANSFORM time, and Metro caches
 * transforms per file. So editing `.env` leaves a stale `undefined` compiled into the bundle until
 * someone remembers `--clear` — a build that succeeds and a screen that says the variable is not
 * defined. `app.config.ts` is re-evaluated every start/prebuild/build and puts the values in
 * `extra`, which no transform cache sits in front of.
 *
 * `process.env` stays as the fallback so the screen still works if `extra` is ever absent.
 */
const spike = Constants.expoConfig?.extra?.spikeVapi as
  | { publicKey?: string; assistantId?: string }
  | undefined;

const PUBLIC_KEY = spike?.publicKey || (process.env.EXPO_PUBLIC_VAPI_PUBLIC_KEY ?? "");
const ASSISTANT_ID = spike?.assistantId || (process.env.EXPO_PUBLIC_VAPI_ASSISTANT_ID ?? "");

/** Vapi's client surface, narrowed to what this screen touches. */
interface VapiClient {
  on(event: string, cb: (payload?: unknown) => void): void;
  start(assistantId: string, overrides?: unknown): Promise<unknown>;
  stop(): void;
  setMuted(muted: boolean): void;
  say(text: string, endCallAfterSpoken?: boolean): void;
}

/**
 * What the runtime resolved, read on demand.
 *
 * Both forks register a native module named `WebRTCModule`; only one survives. Since the whole
 * premise is that LiveKit's is the survivor, this is the cheapest way to see it — and
 * `DailyNativeUtils` appearing beside it confirms Daily's own native pod linked.
 */
function nativeReport(): string[] {
  const keys = Object.keys(NativeModules)
    .filter((k) => /webrtc|daily/i.test(k))
    .sort();
  const g = globalThis as Record<string, unknown>;
  return [
    `native modules: ${keys.length ? keys.join(", ") : "(none)"}`,
    `global.RTCPeerConnection: ${typeof g.RTCPeerConnection} · mediaDevices: ${typeof g.mediaDevices}`,
    `audio policy: ${VOICE_LESSON_CATEGORY}`,
  ];
}

function Button({
  label,
  onPress,
  tone = "default",
}: {
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: tone === "danger" ? "#8A2020" : "#208AEF",
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 8,
      }}
    >
      <Text style={{ color: "#fff", fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export default function SpikeVapi() {
  const [log, setLog] = useState<string[]>(() => nativeReport());
  const [status, setStatus] = useState("idle");
  const [muted, setMuted] = useState(false);
  const vapiRef = useRef<VapiClient | null>(null);

  const say = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
    // Also to the console: a crash takes the UI with it but leaves the log.
    console.log(`[spike-vapi] ${line}`);
  }, []);

  /**
   * Load the SDK and place a call.
   *
   * The `require` is LAZY ON PURPOSE and must stay that way, for two independent reasons:
   *   - the shim above it has to patch `WebRTCModule` before Daily's module initialisation reads
   *     those properties, and a top-level import would run first;
   *   - on a bad build a module-scope import kills the route before it paints, which makes a Vapi
   *     problem indistinguishable from a routing problem.
   */
  const start = useCallback(async () => {
    if (!PUBLIC_KEY || !ASSISTANT_ID) {
      say(
        `MISSING ENV — key=${PUBLIC_KEY ? "set" : "EMPTY"} assistant=${ASSISTANT_ID ? "set" : "EMPTY"}` +
          ` · extra.spikeVapi=${spike ? "present" : "ABSENT"}`,
      );
      say("Set both in apps/mobile/.env, then re-run prebuild (or restart the dev server).");
      return;
    }
    try {
      setStatus("audio");
      // Assert the app's policy BEFORE the SDK starts. audio-session.ts: the moments that matter
      // are before the connection reports connected, and nothing else can assert them for us.
      const started = await ensureStarted();
      const applied = await applyVoiceLessonCategory();
      say(`audio session: started=${started} categoryApplied=${applied}`);

      setStatus("shim");
      const shim = installDailyWebRtcShim();
      say(describeShim(shim));
      if (shim.rejected.length > 0) {
        setStatus("blocked");
        say("STOP: the WebRTCModule object refused the patch. Daily cannot run against this fork.");
        return;
      }

      setStatus("importing");
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy ON PURPOSE, see above
      const mod = require("@vapi-ai/react-native");
      const Vapi = (mod.default ?? mod) as new (key: string) => VapiClient;
      say("SDK loaded — Daily's JS accepted LiveKit's WebRTC package.");
      say(nativeReport().join(" | "));

      const vapi = new Vapi(PUBLIC_KEY);
      vapiRef.current = vapi;

      for (const evt of [
        "call-start",
        "call-end",
        "speech-start",
        "speech-end",
        "error",
        "call-start-progress",
        "call-start-success",
        "call-start-failed",
        "network-connection",
      ]) {
        vapi.on(evt, (payload?: unknown) => {
          const detail = payload ? ` ${JSON.stringify(payload).slice(0, 200)}` : "";
          say(`${evt}${detail}`);
          if (evt === "call-start") setStatus("connected");
          if (evt === "call-end") setStatus("ended");
          if (evt === "call-start-failed") setStatus("failed");
        });
      }
      vapi.on("message", (m?: unknown) => {
        const msg = m as { type?: string; role?: string; transcript?: string } | undefined;
        if (msg?.type === "transcript" && msg.transcript) {
          say(`  ${msg.role}: ${msg.transcript}`);
        } else if (msg?.type) {
          say(`message:${msg.type}`);
        }
      });

      setStatus("connecting");
      say(`starting call → assistant ${ASSISTANT_ID.slice(0, 8)}… — LISTEN NOW`);
      await vapi.start(ASSISTANT_ID);
    } catch (e) {
      setStatus("error");
      const err = e as Error & { code?: string };
      say(`THREW: ${err?.name}: ${err?.message}${err?.code ? ` (${err.code})` : ""}`);
      if (err?.stack) say(err.stack.split("\n").slice(1, 4).join(" ⏎ "));
    }
  }, [say]);

  const stop = useCallback(() => {
    try {
      vapiRef.current?.stop();
      say("stop() called");
    } catch (e) {
      say(`stop THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [say]);

  const toggleMute = useCallback(() => {
    try {
      const next = !muted;
      vapiRef.current?.setMuted(next);
      setMuted(next);
      say(`setMuted(${next})`);
    } catch (e) {
      say(`setMuted THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [muted, say]);

  /** The one control the contract wants that neither existing provider gives us for free (§5.1). */
  const testSay = useCallback(() => {
    try {
      vapiRef.current?.say("This is a test of the say method.", false);
      say('say("…") called — the TUTOR should speak without spending a turn');
    } catch (e) {
      say(`say THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [say]);

  const reassertAudio = useCallback(() => {
    void (async () => {
      const ok = await applyVoiceLessonCategory();
      say(`re-applied ${VOICE_LESSON_CATEGORY} → ${ok}`);
      say("if this made it audible, two owners are fighting over AVAudioSession.");
    })();
  }, [say]);

  useEffect(() => () => vapiRef.current?.stop(), []);

  return (
    <View style={{ flex: 1, padding: 16, paddingTop: 64, backgroundColor: "#000" }}>
      <Text style={{ color: "#fff", fontSize: 20, fontWeight: "700" }}>Vapi spike (path A)</Text>
      <Text style={{ color: "#8a8a8a", marginTop: 4, fontSize: 12 }}>
        status: {status} · muted: {String(muted)} ·{" "}
        {PUBLIC_KEY && ASSISTANT_ID ? "env OK" : "ENV MISSING"}
      </Text>
      <Text style={{ color: "#8a8a8a", marginTop: 2, fontSize: 12 }}>
        Connected is not a pass. Audible is. Run the A/B test in this file&apos;s header.
      </Text>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <Button label="Start Vapi" onPress={start} />
        <Button label="Stop" onPress={stop} tone="danger" />
        <Button label={muted ? "Unmute" : "Mute"} onPress={toggleMute} />
        <Button label="say()" onPress={testSay} />
        <Button label="Re-assert audio" onPress={reassertAudio} />
        <Button label="Clear" onPress={() => setLog(nativeReport())} />
      </View>

      <ScrollView style={{ flex: 1, marginTop: 16 }} contentContainerStyle={{ paddingBottom: 32 }}>
        {log.map((line, i) => (
          <Text
            key={i}
            selectable
            style={{ color: "#c8c8c8", fontSize: 11, fontFamily: "Menlo", marginBottom: 3 }}
          >
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}
