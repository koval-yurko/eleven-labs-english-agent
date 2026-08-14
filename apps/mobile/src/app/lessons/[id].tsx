import { Button, Host, Picker, Text as UIText } from "@expo/ui/swift-ui";
import { buttonStyle, disabled, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
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
import {
  formatItemsList,
  formatResumeContext,
  HIDDEN_KICKOFF_MESSAGES,
  KICKOFF_MESSAGE,
  RESUME_MESSAGE,
  type TranscriptLine,
} from "@tutor/shared/tutor";
import { Stack, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth0 } from "react-native-auth0";

import { apiFetch } from "@/api";
import { clearJournal, readJournal, writeJournal } from "@/lib/session-journal";

/**
 * One lesson's voice tutor — the screen the native app exists for.
 *
 * Ported from `apps/web/src/app/lessons/[id]/LessonTutor.tsx`, which stays exactly as it is: the
 * browser still needs the workarounds deleted here. What survived is the part that was never about
 * the browser — the proactive kickoff, the hidden-message filter, the per-conversation-id save guard,
 * the carried transcript and the resume context. What went is everything that existed because a web
 * page cannot run a voice session in the background: the wake lock, the volume-polling audio health
 * check, the visibility grace timer, the `pagehide` beacons and the `"background"` pause card. S1
 * measured that a locked native app keeps talking, so there is nothing left to apologise for.
 *
 * The one genuinely new design is WHY a session stopped. The browser had to infer it; here the SDK
 * says so — `onDisconnect` carries `reason: "error" | "agent" | "user"` — so every inference is
 * replaced by reading a value. See docs/2026-08-13-expo-s4-tutor-screen.md §3.
 */

/**
 * Why the session is not running. Sourced from `onDisconnect`, never inferred.
 *
 * `reason: "user"` produces NO entry here on purpose: the learner pressed End and does not need to be
 * told what they just did. And there is no `"background"` — that failure cannot happen (S1).
 */
type PauseReason =
  | "dropped" // reason: "error" — the connection failed (network, audio graph, LiveKit)
  | "ended" // reason: "agent" — the tutor or the server ended it (max_duration_seconds is 1800)
  | "recovered"; // a journal from a previous run was found at mount

const PAUSE_COPY: Record<PauseReason, { title: string; body: string; cta: string }> = {
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

export default function LessonTutorScreen() {
  const { id: lessonId } = useLocalSearchParams<{ id: string }>();
  const { getCredentials } = useAuth0();

  const accessToken = useCallback(async () => {
    const credentials = await getCredentials();
    return credentials?.accessToken ?? null;
  }, [getCredentials]);

  // ── the lesson ─────────────────────────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<LessonDetailResponse | null>(null);
  const [versions, setVersions] = useState<AgentVersionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Both fetches, in parallel, on mount — and NOT the conversation token, which is minted at the
   * moment of connect (S3 D28): it lives 900 s and creates the conversation id with it, so fetching
   * it here would hand a stale one to a learner who read the word list first.
   *
   * `agent-versions` stays a separate call rather than a field on the lesson: it is not lesson data,
   * it changes on deploy rather than on edit, and folding it in would make every lesson read depend
   * on the agent registry.
   */
  const load = useCallback(async () => {
    try {
      const [lesson, agents] = await Promise.all([
        apiFetch<unknown>(lessonPath(lessonId), accessToken),
        apiFetch<unknown>(API_V2_ROUTES.agentVersions, accessToken),
      ]);
      if (!isLessonDetailResponse(lesson)) throw new Error("Malformed lesson response.");
      setDetail(lesson);
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
  const resumeContextRef = useRef<TranscriptLine[] | null>(null);
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
      // room name and falls back to `room_<timestamp>` when that name is empty, which no other writer
      // would ever produce. S3 measured them agreeing; this is the tripwire for the day they stop.
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
     * in an app whose whole premise is interrupting freely. The web app has never wired it and mostly
     * gets away with it because the post-call webhook overwrites the row with ElevenLabs' corrected
     * copy; "mostly" is the problem, since a webhook that fails leaves the wrong text permanent.
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
    onStatusChange: ({ status }) => {
      statusRef.current = status;
    },
    onDisconnect: (details) => {
      kickedOffRef.current = false;
      void persistSession();
      // The whole pause machine, in three lines: the SDK says why, so nothing is inferred.
      if (details.reason === "error") setPause("dropped");
      else if (details.reason === "agent") setPause("ended");
      // "user" — the learner pressed End and knows it. No card.
      if (details.reason !== "user" && linesRef.current.length > 0) {
        resumeContextRef.current = linesRef.current;
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
   * message — that reliably makes the agent take its opening turn without the learner speaking first.
   * A resumed session gets the interrupted conversation as context first, so it continues instead of
   * starting the lesson over.
   *
   * Keyed on `status` and it must stay that way: `WebRTCConnection.sendMessage` drops anything sent
   * before `RoomEvent.Connected` with a console warning and no error.
   */
  useEffect(() => {
    if (status !== "connected" || kickedOffRef.current) return;
    kickedOffRef.current = true;
    const resumeFrom = resumeContextRef.current;
    resumeContextRef.current = null;
    if (resumeFrom && resumeFrom.length > 0) {
      sendContextualUpdate(formatResumeContext(resumeFrom));
      sendUserMessage(RESUME_MESSAGE);
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
   * A journal left behind means the last session died without saving — a crash or a force-quit, since
   * backgrounding is survivable here. Push it to the server, then offer to carry on.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const journal = await readJournal(lessonId);
      if (cancelled || !journal || journal.lines.length === 0) return;
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
      resumeContextRef.current = journal.lines;
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

      const resuming = (resumeContextRef.current?.length ?? 0) > 0;
      // Either way the next conversation starts with a transcript of its own; resuming moves what was
      // already said into the read-only carried block above it.
      setCarried(resuming ? (prev) => [...prev, ...linesRef.current] : []);
      setLines([]);
      linesRef.current = [];
      await clearJournal(lessonId);
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
  }

  // ── render ─────────────────────────────────────────────────────────────────────────────────
  const transcript = useMemo(() => carried.concat(lines), [carried, lines]);
  const versionOptions = versions?.versions ?? [];

  if (loadError) {
    return (
      <Screen title="Lesson">
        <Text style={styles.error}>{loadError}</Text>
        <Pressable style={styles.retry} onPress={() => void load()}>
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </Screen>
    );
  }

  if (!detail) {
    return (
      <Screen title="Lesson">
        <ActivityIndicator color="#7FB2FF" style={{ marginTop: 24 }} />
      </Screen>
    );
  }

  return (
    <Screen title={detail.lesson.title}>
      <Text style={styles.muted}>
        {detail.lesson.items.length} words · {detail.sessionCount}{" "}
        {detail.sessionCount === 1 ? "conversation" : "conversations"}
      </Text>

      {/* Expo UI, kept deliberately small on its first outing (D39): SwiftUI owns the two controls,
          RN owns every layout and the one scrolling thing on the screen. */}
      {versionOptions.length > 1 ? (
        <Host style={styles.pickerHost}>
          <Picker
            label="Tutor version"
            selection={selectedVersion}
            onSelectionChange={(v) => setVersion(v)}
            modifiers={[pickerStyle("menu"), disabled(connected || busy)]}
          >
            {versionOptions.map((v) => (
              <UIText key={v.version} modifiers={[tag(v.version)]}>
                {v.label}
              </UIText>
            ))}
          </Picker>
        </Host>
      ) : null}

      <Host matchContents style={styles.buttonHost}>
        <Button
          label={busy ? "Connecting…" : connected ? "End session" : "Start conversation"}
          role={connected ? "destructive" : "default"}
          onPress={connected ? () => endSession() : () => void start()}
          modifiers={[buttonStyle("borderedProminent"), disabled(busy)]}
        />
      </Host>

      <Text style={styles.status}>
        {connected ? "● listening — just talk to interrupt" : `status: ${status}`}
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {pause && !connected ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{PAUSE_COPY[pause].title}</Text>
          <Text style={styles.muted}>{PAUSE_COPY[pause].body}</Text>
          <View style={styles.cardActions}>
            <Pressable style={styles.retry} onPress={() => void start()} disabled={busy}>
              <Text style={styles.retryLabel}>{PAUSE_COPY[pause].cta}</Text>
            </Pressable>
            <Pressable style={styles.quiet} onPress={dismissPause} disabled={busy}>
              <Text style={styles.quietLabel}>Start fresh instead</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/*
        A FlatList, not an array map, and a memoised row: every transcript line re-renders this screen
        because the combined `useConversation` hook is deliberately kept for the port (D37). These two
        cheap things come first; splitting the hooks is an optimisation to make with a measurement.
      */}
      <FlatList
        style={styles.transcript}
        data={transcript}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <Line line={item} />}
        ListEmptyComponent={
          <Text style={styles.muted}>
            Press start and discuss these words out loud: {detail.lesson.items.join(", ")}
          </Text>
        }
      />
    </Screen>
  );
}

const Line = memo(function Line({ line }: { line: TranscriptLine }) {
  return (
    <Text style={styles.line}>
      <Text style={line.role === "agent" ? styles.agent : styles.you}>
        {line.role === "agent" ? "Teacher" : "You"}:{" "}
      </Text>
      {line.text}
    </Text>
  );
});

function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <Stack.Screen options={{ headerShown: true, title, headerBackTitle: "Lessons" }} />
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101014", paddingHorizontal: 16 },
  muted: { color: "#8A8A8A", fontSize: 13, marginTop: 8 },
  status: { color: "#7FB2FF", fontSize: 13, marginTop: 8 },
  error: { color: "#FF7A7A", fontSize: 13, marginTop: 8 },
  pickerHost: { height: 44, marginTop: 8 },
  buttonHost: { marginTop: 12, alignSelf: "flex-start" },
  card: {
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#FFC46B",
    backgroundColor: "#1B1B22",
  },
  cardTitle: { color: "#E6E6E6", fontSize: 16, fontWeight: "700" },
  cardActions: { flexDirection: "row", gap: 8, marginTop: 12 },
  retry: { backgroundColor: "#2A2A34", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  retryLabel: { color: "#E6E6E6", fontSize: 15, fontWeight: "600" },
  quiet: { paddingVertical: 10, paddingHorizontal: 6 },
  quietLabel: { color: "#8A8A8A", fontSize: 15 },
  transcript: { flex: 1, marginTop: 16 },
  line: { color: "#E6E6E6", fontSize: 15, marginBottom: 10 },
  agent: { color: "#7FB2FF", fontWeight: "700" },
  you: { color: "#7DFF9B", fontWeight: "700" },
});
