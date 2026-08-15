import { useConversation } from "@elevenlabs/react-native";
import {
  API_V2_ROUTES,
  conversationTokenPath,
  isConversationTokenResponse,
  type ConversationTokenResponse,
  type TutorSessionInput,
} from "@tutor/shared/api";
import {
  formatItemsList,
  HIDDEN_KICKOFF_MESSAGES,
  KICKOFF_MESSAGE,
  type TranscriptLine,
  type TutorItem,
} from "@tutor/shared/tutor";
import Constants from "expo-constants";
import { Link } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  type AppStateStatus,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth0 } from "react-native-auth0";

import { apiFetch } from "@/api";
import { useEventLog } from "@/hooks/use-event-log";
import { useTheme, type Palette } from "@/theme";
import { useSuspensionProbe } from "@/hooks/use-suspension-probe";

/**
 * S1's suspension probe, driven by S3's token route. **Not a product screen — an instrument.**
 *
 * It moved off `/` at S4 (D43) and was deliberately not deleted: it is the regression check for every
 * SDK, LiveKit and iOS upgrade, and nothing else in the app reports drift, per-direction turn counts,
 * `AppState` transitions or the two B3 tripwires. The two rules that made S1's numbers mean anything
 * still apply — NO DEBUGGER, Release configuration.
 *
 * S1 asked whether a locked screen kills a live conversation (it does not). S3 asked whether the
 * `conversation_id` we key `lesson_sessions` on survives the WebRTC transport (it does).
 *
 * What changed from S1:
 *   - the session starts from a CONVERSATION TOKEN minted by our server, not a public `agentId`;
 *   - `conversationIdRef` is seeded from that response BEFORE startSession, and nothing overwrites
 *     it — the SDK derives its own id from the LiveKit room name and can fall back to
 *     `room_${Date.now()}`, which no other writer will ever produce;
 *   - both `onConversationMetadata` and `onConnect` are compared against it and warn on a mismatch;
 *   - the transcript is posted to `/api/v2/lessons/session` when the session ends.
 *
 * See docs/2026-08-13-expo-s3-conversation-token.md §6.
 */

/**
 * S3 hard-codes the lesson, deliberately (research doc §5.5): the stage's question is the
 * conversation id, and `GET /api/v2/lessons/:id` is S4's work. Every extra route here is one more
 * thing that can fail the run for an unrelated reason.
 *
 * The id must be a lesson owned by the signed-in learner, or the save answers 404. The word list
 * only has to be plausible — S4 replaces both with the real lesson payload.
 */
const LESSON_ID = "eb47597e-cac3-446b-b5de-26b0ebd068c2";
const LESSON_ITEMS: TutorItem[] = [
  { text: "incentive", details: null },
  { text: "obscure", details: null },
  { text: "inevitable", details: null },
];

export default function ProbeScreen() {
  const { entries, log, clear } = useEventLog();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const kindStyles = useMemo(() => makeKindStyles(theme), [theme]);
  const { getCredentials } = useAuth0();

  // Toggled by the buttons rather than derived from `status`, so the probe also measures the
  // connecting window — a session that never connects still produces a readable timeline.
  const [sessionActive, setSessionActive] = useState(false);
  const { drift, maxDrift, elapsed } = useSuspensionProbe(sessionActive);

  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  /**
   * THE ROW KEY. Seeded from the token response before the session starts, and never written by a
   * callback. Everything else about the id is advisory.
   */
  const conversationIdRef = useRef<string | null>(null);
  const versionRef = useRef<string>("");
  const linesRef = useRef<TranscriptLine[]>([]);
  /** Per-conversation save guard: a reconnect must not re-post the same transcript. */
  const savedForRef = useRef<string | null>(null);

  const accessToken = useCallback(async () => {
    const credentials = await getCredentials();
    return credentials?.accessToken ?? null;
  }, [getCredentials]);

  /** Post the collected transcript. Called on disconnect; idempotent per conversation id. */
  const saveTranscript = useCallback(async () => {
    const id = conversationIdRef.current;
    if (!id || savedForRef.current === id) return;
    savedForRef.current = id;

    const payload: TutorSessionInput = {
      lessonId: LESSON_ID,
      conversationId: id,
      agentVersion: versionRef.current,
      lines: linesRef.current,
    };
    try {
      await apiFetch(API_V2_ROUTES.lessonSession, accessToken, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      log("status", `transcript saved · ${payload.lines.length} lines · ${id}`);
    } catch (e) {
      // Un-guard so a retry is possible: a lost transcript is the one failure this stage cannot
      // recover from after the fact.
      savedForRef.current = null;
      log("error", `save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [accessToken, log]);

  const conversation = useConversation({
    onConnect: ({ conversationId: sdkId }) => {
      log("status", `connected · sdk id ${sdkId}`);
      // ADVISORY ONLY — compared, never trusted, never written to the ref. The SDK derives this
      // from `room.name` and falls back to `room_<timestamp>` when that is empty. In the normal
      // path it agrees with the token id; this is the tripwire for the day it stops.
      const authoritative = conversationIdRef.current;
      if (authoritative && sdkId !== authoritative) {
        log("error", `B3: onConnect id ${sdkId} ≠ token id ${authoritative}`);
      }
      if (!/^conv_/.test(sdkId)) {
        log("error", `B3: derived id is not conv_* → "${sdkId}"`);
      }
    },
    // The server's OWN id, delivered in band over the data channel — a strictly better cross-check
    // than the derived one. Silence here means "no cross-check available", not an error: the
    // WebRTC connection does not wait for this event the way the WebSocket one does.
    onConversationMetadata: ({ conversation_id }) => {
      const authoritative = conversationIdRef.current;
      log("note", `metadata id ${conversation_id}`);
      if (authoritative && conversation_id !== authoritative) {
        log("error", `B3: metadata id ${conversation_id} ≠ token id ${authoritative}`);
      }
    },
    onDisconnect: (details) => {
      log("status", `disconnected · reason=${details.reason}`);
      void saveTranscript();
    },
    onStatusChange: ({ status }) => log("status", status),
    // Split by role, because the two directions fail independently and only one of them is
    // audible. A locked-screen session where iOS kept playback alive but killed microphone capture
    // produces agent lines and NO user lines — which passes every other criterion while being a
    // tutor you cannot talk to.
    onMessage: ({ message, role }) => {
      // The kickoff is a hidden instruction, not a learner turn: it is filtered out of the stored
      // history by every other writer, so it must not be collected here either.
      if (!HIDDEN_KICKOFF_MESSAGES.includes(message)) {
        linesRef.current = [...linesRef.current, { role, text: message }];
      }
      log(role === "user" ? "you" : "agent", `${role}: ${message}`);
    },
    // The mic prompt is triggered by the SDK itself (no pre-flight call), so a DENIED microphone
    // arrives here as a session error rather than as a permission dialog.
    onError: (message) => log("error", `${message} (a denied microphone also looks like this)`),
  });

  const { status, isMuted, setMuted, startSession, endSession, sendUserMessage } = conversation;

  // AppState transitions are an OBSERVATION, not an assumption: lock, app-switch and Siri produce
  // different sequences, and S1's test D exists because backgrounding and locking are different
  // suspension paths.
  const appStateRef = useRef(appState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      log("appstate", `${appStateRef.current} → ${next}`);
      appStateRef.current = next;
      setAppState(next);
    });
    return () => sub.remove();
  }, [log]);

  /**
   * Proactive kickoff: the agent greets and starts teaching on its own once connected. An empty
   * first_message makes it wait for the learner, and a hidden user message reliably triggers its
   * opening turn.
   */
  const kickedOffRef = useRef(false);
  useEffect(() => {
    if (status !== "connected" || kickedOffRef.current) return;
    kickedOffRef.current = true;
    sendUserMessage(KICKOFF_MESSAGE);
    log("note", "kickoff sent");
  }, [status, sendUserMessage, log]);

  const onStart = useCallback(async () => {
    clear();
    setConversationId(null);
    setVersion(null);
    conversationIdRef.current = null;
    savedForRef.current = null;
    linesRef.current = [];
    kickedOffRef.current = false;

    let body: ConversationTokenResponse;
    try {
      // Minted HERE, immediately before startSession — the token lives 900 s and the conversation
      // id is created with it, so fetching at screen mount would hand a stale token to a learner
      // who read the word list first.
      log("note", "requesting conversation token…");
      const res = await apiFetch<unknown>(conversationTokenPath(), accessToken, { method: "POST" });
      if (!isConversationTokenResponse(res)) {
        log("error", "malformed token response — missing token, conversationId or appEnv");
        return;
      }
      body = res;
    } catch (e) {
      log("error", `token request failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Seeded BEFORE startSession. From here on this is the row key, whatever the transport says.
    conversationIdRef.current = body.conversationId;
    versionRef.current = body.version;
    setConversationId(body.conversationId);
    setVersion(body.version);
    log("note", `token ok · ${body.version} · ${body.appEnv} · ${body.conversationId}`);

    setSessionActive(true);
    startSession({
      conversationToken: body.token,
      connectionType: "webrtc", // the only transport the RN SDK supports; websocket throws
      // Never hold the screen awake: "passes only with the screen awake-but-dimmed" is not a pass.
      useWakeLock: false,
      dynamicVariables: {
        items_list: formatItemsList(LESSON_ITEMS),
        lesson_id: LESSON_ID,
        // Required, never defaulted — the post-call webhook routes on it, and a missing one files
        // the session under the wrong environment.
        app_env: body.appEnv,
      },
    });
  }, [accessToken, clear, log, startSession]);

  const onEnd = useCallback(() => {
    log("note", "ending session");
    endSession();
    setSessionActive(false);
  }, [endSession, log]);

  // The uplink tally: how many turns got through in each direction.
  const youTurns = entries.filter((e) => e.kind === "you").length;
  const agentTurns = entries.filter((e) => e.kind === "agent").length;

  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier ?? "unknown";

  return (
    <SafeAreaView style={styles.screen}>
      <Link href="/" style={styles.link}>
        ← home
      </Link>

      <View style={styles.stats}>
        <Stat label="status" value={status} />
        <Stat label="app state" value={appState} />
        <Stat label="elapsed" value={`${elapsed.toFixed(0)}s`} />
        <Stat label="drift" value={`${drift.toFixed(2)}s`} />
        {/* The one S1's gate is read from: < 3s passes. Live `drift` can collapse back to ~0. */}
        <Stat label="MAX DRIFT" value={`${maxDrift.toFixed(2)}s`} emphasis />
        <Stat label="mic" value={isMuted ? "muted" : "live"} />
        <Stat label="you / agent turns" value={`${youTurns} / ${agentTurns}`} />
        <Stat label="version" value={version ?? "—"} />
      </View>

      <Text style={styles.meta} numberOfLines={1}>
        {bundleId}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {conversationId ?? "no conversation id yet"}
      </Text>

      <View style={styles.buttons}>
        <Button
          label={sessionActive ? "End" : "Start"}
          onPress={sessionActive ? onEnd : () => void onStart()}
        />
        <Button label={isMuted ? "Unmute" : "Mute"} onPress={() => setMuted(!isMuted)} />
      </View>

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

function Stat({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, emphasis && styles.statValueEmphasis]}>{value}</Text>
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

/**
 * Per-scheme styles (D71) — see the note in app/(tabs)/(lessons)/index.tsx.
 *
 * `KIND_STYLE` is indexed by the log entry's kind, so it becomes a factory alongside `makeStyles`
 * rather than staying a module constant.
 */
const makeKindStyles = (t: Palette) =>
  StyleSheet.create({
    // `you` is the loudest colour on the screen: it is the one thing a locked-screen failure removes
    // while leaving everything else looking healthy.
    you: { color: t.success, fontWeight: "700" },
    agent: { color: t.text },
    status: { color: t.accent },
    appstate: { color: t.warning },
    error: { color: t.danger },
    note: { color: t.muted },
  });

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 16 },
    link: { color: t.accent, fontSize: 12, paddingVertical: 8, textAlign: "right" },
    stats: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 8 },
    stat: { minWidth: "30%", flexGrow: 1, backgroundColor: t.surface, borderRadius: 8, padding: 8 },
    statLabel: { color: t.muted, fontSize: 10, fontVariant: ["tabular-nums"] },
    statValue: { color: t.text, fontSize: 18, fontVariant: ["tabular-nums"] },
    statValueEmphasis: { color: t.success, fontWeight: "700" },
    meta: { color: t.faint, fontSize: 10, marginTop: 6 },
    buttons: { flexDirection: "row", gap: 8, marginVertical: 12 },
    button: { flex: 1, backgroundColor: t.control, borderRadius: 8, paddingVertical: 14 },
    buttonLabel: { color: t.text, textAlign: "center", fontSize: 16, fontWeight: "600" },
    log: { flex: 1, backgroundColor: t.sunken, borderRadius: 8 },
    logContent: { padding: 8, gap: 2 },
    line: { fontSize: 11, fontVariant: ["tabular-nums"] },
  });
