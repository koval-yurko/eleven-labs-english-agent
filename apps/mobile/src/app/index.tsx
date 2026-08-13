import { useConversation } from "@elevenlabs/react-native";
import Constants from "expo-constants";
import { Link } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { env } from "@/env";
import { useEventLog } from "@/hooks/use-event-log";
import { useSuspensionProbe } from "@/hooks/use-suspension-probe";

/**
 * S1 — the suspension probe. The whole product surface of this stage.
 *
 * The question is B2: does a locked screen kill a live conversation? You cannot watch a locked
 * screen, so nothing here is observed live — everything is measured and written to a scrollback
 * that is read AFTER unlocking. See docs/2026-08-13-expo-s1-background-audio.md §5 and §6.
 *
 * Two rules that decide whether any number on this screen means anything:
 *   1. NO DEBUGGER. Xcode's debugger prevents iOS from suspending the app at all — it prints a
 *      confident green pass on a test that never happened. Measure on a `preview` build installed
 *      from a link and launched from the home screen.
 *   2. RELEASE CONFIGURATION, never a dev client, whose Metro connection drops on background and
 *      manufactures false failures.
 *
 * Keep this screen after S1 goes green: it is the regression check for every SDK and iOS upgrade.
 */
export default function SuspensionProbeScreen() {
  const { entries, log, clear } = useEventLog();

  // Toggled by the buttons rather than derived from `status`, so the probe also measures the
  // connecting window — a session that never connects still produces a readable timeline.
  const [sessionActive, setSessionActive] = useState(false);
  const { drift, maxDrift, elapsed } = useSuspensionProbe(sessionActive);

  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const conversation = useConversation({
    onConnect: ({ conversationId: id }) => {
      setConversationId(id);
      log("status", `connected · ${id}`);
      // A free early look at the B3 hazard (creation doc §9 B3): on WebRTC the SDK DERIVES this id
      // from room.name and falls back to `room_${Date.now()}` when that is empty. Any such id never
      // matches what the post-call webhook reports. S3 fixes it by taking the id from the token
      // route; S1 only needs to know whether it happens.
      if (!/^conv_/.test(id)) log("error", `conversationId is NOT conv_* → "${id}" (B3 hazard)`);
    },
    onDisconnect: (details) => log("status", `disconnected · reason=${details.reason}`),
    onStatusChange: ({ status }) => log("status", status),
    // Split by role, because the two directions fail independently and only one of them is
    // audible. A locked-screen session where iOS kept playback alive but killed microphone capture
    // produces agent lines and NO user lines — which passes every other criterion while being a
    // tutor you cannot talk to. See the research doc §7, criterion 4.
    onMessage: ({ message, role }) =>
      role === "user" ? log("you", `you: ${message}`) : log("agent", `agent: ${message}`),
    // The mic prompt is triggered by the SDK itself (no pre-flight call), so a DENIED microphone
    // arrives here as a session error rather than as a permission dialog.
    onError: (message) => log("error", `${message} (a denied microphone also looks like this)`),
  });

  const { status, isMuted, setMuted, startSession, endSession } = conversation;

  // AppState transitions are an OBSERVATION, not an assumption: lock, app-switch and Siri produce
  // different sequences, and test D exists because backgrounding and locking are different
  // suspension paths. Recording them here is what S4's session UI gets written against.
  const appStateRef = useRef(appState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      log("appstate", `${appStateRef.current} → ${next}`);
      appStateRef.current = next;
      setAppState(next);
    });
    return () => sub.remove();
  }, [log]);

  const onStart = useCallback(() => {
    clear();
    setConversationId(null);
    setSessionActive(true);
    log("note", `starting · agent ${env.agentId}`);
    startSession({
      agentId: env.agentId,
      connectionType: "webrtc", // the only transport the RN SDK supports; websocket throws
      // Never hold the screen awake: "passes only with the screen awake-but-dimmed" is not a pass.
      useWakeLock: false,
    });
  }, [clear, log, startSession]);

  const onEnd = useCallback(() => {
    log("note", "ending session");
    endSession();
    setSessionActive(false);
  }, [endSession, log]);

  // The uplink tally: how many turns got through in each direction. After unlocking, "you" is the
  // number to check against the words you actually spoke into the locked phone (§6.3, alpha-echo).
  const youTurns = entries.filter((e) => e.kind === "you").length;
  const agentTurns = entries.filter((e) => e.kind === "agent").length;

  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier ?? "unknown";

  return (
    <SafeAreaView style={styles.screen}>
      <Link href="/auth" style={styles.link}>
        S2 auth →
      </Link>

      <View style={styles.stats}>
        <Stat label="status" value={status} />
        <Stat label="app state" value={appState} />
        <Stat label="elapsed" value={`${elapsed.toFixed(0)}s`} />
        <Stat label="drift" value={`${drift.toFixed(2)}s`} />
        {/* The one the gate is read from: < 3s passes. Live `drift` can collapse back to ~0. */}
        <Stat label="MAX DRIFT" value={`${maxDrift.toFixed(2)}s`} emphasis />
        <Stat label="mic" value={isMuted ? "muted" : "live"} />
        {/* Uplink vs downlink turn counts — criterion 4 is read from the first of these. */}
        <Stat label="you / agent turns" value={`${youTurns} / ${agentTurns}`} />
      </View>

      <Text style={styles.meta} numberOfLines={1}>
        {bundleId}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {conversationId ?? "no conversation id yet"}
      </Text>

      <View style={styles.buttons}>
        <Button label={sessionActive ? "End" : "Start"} onPress={sessionActive ? onEnd : onStart} />
        {/* Test C: mute and lock, to check whether track PRESENCE alone holds the app awake. */}
        <Button label={isMuted ? "Unmute" : "Mute"} onPress={() => setMuted(!isMuted)} />
      </View>

      <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
        {entries.map((e) => (
          <Text key={e.id} style={[styles.line, KIND_STYLE[e.kind]]}>
            {e.at} {e.text}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, emphasis && styles.statValueEmphasis]}>{value}</Text>
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

const KIND_STYLE = StyleSheet.create({
  // `you` is the loudest colour on the screen: it is the one thing a locked-screen failure removes
  // while leaving everything else looking healthy.
  you: { color: "#7DFF9B", fontWeight: "700" },
  agent: { color: "#E6E6E6" },
  status: { color: "#7FB2FF" },
  appstate: { color: "#FFC46B" },
  error: { color: "#FF7A7A" },
  note: { color: "#8A8A8A" },
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101014", paddingHorizontal: 16 },
  link: { color: "#7FB2FF", fontSize: 12, paddingVertical: 8, textAlign: "right" },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 8 },
  stat: { minWidth: "30%", flexGrow: 1, backgroundColor: "#1B1B22", borderRadius: 8, padding: 8 },
  statLabel: { color: "#8A8A8A", fontSize: 10, fontVariant: ["tabular-nums"] },
  statValue: { color: "#E6E6E6", fontSize: 18, fontVariant: ["tabular-nums"] },
  statValueEmphasis: { color: "#7DFF9B", fontWeight: "700" },
  meta: { color: "#5A5A5A", fontSize: 10, marginTop: 6 },
  buttons: { flexDirection: "row", gap: 8, marginVertical: 12 },
  button: { flex: 1, backgroundColor: "#2A2A34", borderRadius: 8, paddingVertical: 14 },
  buttonLabel: { color: "#E6E6E6", textAlign: "center", fontSize: 16, fontWeight: "600" },
  log: { flex: 1, backgroundColor: "#16161C", borderRadius: 8 },
  logContent: { padding: 8, gap: 2 },
  line: { fontSize: 11, fontVariant: ["tabular-nums"] },
});
