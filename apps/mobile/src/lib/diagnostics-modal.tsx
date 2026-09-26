import {
  MAX_DEBUG_TRANSCRIPT_TAIL,
  type DebugEvent,
  type DebugLevel,
  type DebugReportKind,
  type SessionSnapshot,
} from "@tutor/shared/debug/report";
import { type Palette } from "@tutor/shared/theme";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";

import { useAccessToken } from "@/lib/auth";
import {
  buildDebugReport,
  debugClient,
  readEvents,
  readFrozenSnapshot,
  readSnapshot,
  subscribe,
} from "@/lib/diagnostics";
import { sendOrSpool, spooledCount, type SendOutcome } from "@/lib/diagnostics-spool";
import { useTutorSession } from "@/lib/tutor-session";
import { useTheme } from "@/theme";
import {
  Button,
  ButtonRow,
  Checkbox,
  Chip,
  ChipRow,
  Body,
  ErrorText,
  Faint,
  Muted,
  overlay,
  radius,
  space,
  TextField,
  type,
} from "@/ui";

/**
 * The diagnostics modal: **Now**, **Log** and **Send**.
 *
 * ## What it is not
 *
 * It is not a place to fix anything. No "force disconnect", no "clear journal", no "re-mint token".
 * Every one of those is a foot-gun that will eventually be pressed during a live billed lesson, and
 * each duplicates a control that already exists elsewhere with different semantics. **Read-only,
 * plus Send.**
 *
 * `Share` sits beside Send rather than being replaced by it: it needs no network and no account, so
 * it is the escape hatch for the case where the send path itself is what is broken.
 *
 * ## Where it lives
 *
 * `src/lib/`, beside the bus it renders, and NOT under `src/app/` — expo-router turns every file
 * there into a route, so a component dropped next to `lessons/[id]/index.tsx` would be reachable at
 * `/lessons/[id]/DiagnosticsModal`. `tutor-session.tsx` is the precedent: a `.tsx` in `lib/` is
 * where this app puts React that is neither a screen nor a design-system component.
 *
 * See docs/2026-09-09-mobile-debug-reports-and-feedback.md §7.
 */
export function DiagnosticsModal({
  open,
  onOpenChange,
  onFiled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * A report left the composer — sent, or parked in the spool. The modal closes on both, so this
   * is how the receipt (the id to quote) reaches a surface the learner can still see. Not called
   * for a dropped report: that one stays here, with the note that produced it.
   */
  onFiled?: (outcome: SendOutcome) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [tab, setTab] = useState<"now" | "log" | "send">("now");

  /**
   * The composer's state lives HERE, not in the Send tab.
   *
   * A tab switch unmounts the tab, and a draft that disappeared because someone looked at the log
   * to check what they were describing is the fastest way to teach a person not to file reports.
   */
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<DebugReportKind | null>(null);
  const [includeTranscript, setIncludeTranscript] = useState(false);

  /**
   * A filed report empties the composer and closes the modal — debug report `113f2603`.
   *
   * Before this, the note survived the send: the modal stayed open on the outcome, and the next
   * time it was opened the previous report's text was still in the field. That is worse than an
   * inconvenience. The composer state lives up here on purpose (see above) and the modal is never
   * unmounted, so the draft persisted across every open until it was manually deleted — which
   * makes the next report arrive describing the previous one's problem.
   *
   * **Success only.** A `dropped` report is gone and the note is the only part of it a machine
   * could not reproduce; clearing it would destroy the one thing worth keeping. So a failure keeps
   * the modal open and the text where it is, and the learner can press Send again.
   *
   * The tab is reset too. Reopening onto a Send tab whose fields were just emptied looks like a
   * form that lost its contents; `Now` is where the modal opens from cold, and that is what this
   * should look like.
   */
  const handleFiled = useCallback(
    (outcome: SendOutcome) => {
      if (outcome.kind === "dropped") return;
      setNote("");
      setKind(null);
      setIncludeTranscript(false);
      setTab("now");
      onFiled?.(outcome);
      onOpenChange(false);
    },
    [onFiled, onOpenChange],
  );

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => onOpenChange(false)}
    >
      <View style={styles.scrim}>
        <View style={styles.popup} accessibilityViewIsModal accessibilityLabel="Diagnostics">
          <View style={styles.header}>
            <Text style={styles.title}>Diagnostics</Text>
            <ChipRow>
              <Chip label="Now" pressed={tab === "now"} onPress={() => setTab("now")} />
              <Chip label="Log" pressed={tab === "log"} onPress={() => setTab("log")} />
              <Chip label="Send" pressed={tab === "send"} onPress={() => setTab("send")} />
            </ChipRow>
          </View>

          {/* Mounted only while open, so `useSyncExternalStore` is subscribed only while open —
              which is the whole reason the bus is a module and not a context. */}
          {!open ? null : tab === "now" ? (
            <NowTab />
          ) : tab === "log" ? (
            <LogTab />
          ) : (
            <SendTab
              note={note}
              onNote={setNote}
              kind={kind}
              onKind={setKind}
              includeTranscript={includeTranscript}
              onIncludeTranscript={setIncludeTranscript}
              onFiled={handleFiled}
            />
          )}

          <ButtonRow style={styles.actions}>
            <Button variant="secondary" label="Close" onPress={() => onOpenChange(false)} />
            <ShareButton note={note} kind={kind} />
          </ButtonRow>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The offline escape hatch, and the reason it is not `expo-clipboard`.
 *
 * `Share` needs no new dependency, no config plugin and no prebuild, and it reaches Mail, Messages
 * and Files — which is what you actually want from a phone that has just failed to talk to the
 * server. A clipboard would need somewhere to paste to, and the app that has the bug is the one you
 * are standing in.
 *
 * The report goes through `buildDebugReport`, so what leaves is bounded and redacted exactly as a
 * stored one is: same sanitizer, same limits, no second path with its own idea of what is safe.
 */
function ShareButton({ note, kind }: { note: string; kind: DebugReportKind | null }) {
  return (
    <Button
      variant="secondary"
      label="Share"
      onPress={() => {
        const report = buildDebugReport({ kind: kind ?? "manual", note });
        void Share.share({
          title: "Tutor diagnostics",
          message: JSON.stringify(report, null, 2),
        });
      }}
    />
  );
}

// ── Now ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The snapshot as labelled rows, in the order an investigation reads them.
 *
 * **Differing values are the point.** `focused ≠ conversation`, `conversationId ≠ savedFor`, and
 * `owns ✗ while status connected` are each one glance from being obvious, and each is a hazard
 * `tutor-session.tsx` documents having been designed against. So the mismatching ones are rendered
 * in the error tone rather than left for the eye to catch.
 */
function NowTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // Read once per open, not subscribed: this is a photograph, and a panel that changed while being
  // read would be a worse photograph.
  const live = readSnapshot();
  const frozen = readFrozenSnapshot();
  const client = debugClient();

  if (!live) {
    return (
      <ScrollView style={styles.body}>
        <Muted>No tutor session is mounted on this screen.</Muted>
      </ScrollView>
    );
  }

  const idle = live.status === "disconnected";
  return (
    <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
      <Row label="BUILD" value={`${client.appVersion} (${client.buildNumber || "?"}) · ${client.variant} · ${client.platform} ${client.osVersion} · ${client.deviceModel}`} />
      <Row label="API" value={client.apiBaseUrl} />
      <Row
        label="LESSON"
        value={`focused ${short(live.focusedLesson)} · conversation ${short(live.conversationLesson)}`}
        // The documented hazard: a transcript filed under whichever lesson was opened next is, in
        // the session's own words, "not recoverable".
        bad={live.conversationLesson !== null && live.conversationLesson !== live.focusedLesson}
      />
      <Row label="PROVIDER" value={`${live.provider ?? "—"} · ${live.version ?? "—"}`} />
      <Row
        label="SESSION"
        value={`status ${live.status} · owns ${tick(live.owns)} · starting ${tick(live.starting)} · kickedOff ${tick(live.kickedOff)}`}
        // A conversation running that this session does not own pushes turns into someone else's
        // transcript and gets a second kickoff. `starting` covers the takeover half-beat, where
        // `owns` is legitimately false while connected.
        bad={live.status === "connected" && !live.owns && !live.starting}
      />
      <Row
        label="PAUSE"
        value={
          live.held
            ? `held · silenced ${tick(live.silenced)} · heartbeat ${tick(live.heartbeat)}${live.holdSnapshot ? ` · ${live.holdSnapshot.aborted ? "aborted mid-turn" : "was listening"}` : ""}`
            : "not held"
        }
        // A pause that did not silence the tutor is a tutor still talking to a learner who has
        // walked away — the one pause failure the status line already refuses to hide.
        bad={live.held && !live.silenced}
      />
      <Row
        label="TRANSCRIPT"
        value={`${live.lines} lines · carried ${live.carried} · saved-for ${short(live.savedFor)}`}
        // A conversation with lines that has not been saved under its own id: either the save is
        // still in flight, or it silently no-op'd.
        bad={live.lines > 0 && live.conversationId !== null && live.savedFor !== live.conversationId && idle}
      />
      <Row
        label="USAGE"
        value={
          live.usage
            ? `in ${live.usage.inputTokens} · out ${live.usage.outputTokens} · audio-in ${live.usage.inputAudioTokens} · audio-out ${live.usage.outputAudioTokens}`
            : "not reported by this provider"
        }
      />
      <Row
        label="CAPS"
        value={
          live.capabilities
            ? `silenceOutput ${tick(live.capabilities.silenceOutput)} · userActivity ${tick(live.capabilities.userActivity)} · cancelTurn ${tick(live.capabilities.cancelTurn)} · responseCorrection ${tick(live.capabilities.responseCorrection)} · opensUnprompted ${tick(live.capabilities.opensUnprompted)}`
            : "—"
        }
      />
      <Row
        label="RESUME"
        value={live.resumeCause ? `${live.resumeCause} · ${live.resumeLines} lines waiting` : "nothing carried"}
      />
      <Row label="LAST ERROR" value={live.lastError ?? "none"} bad={live.lastError !== null} />

      {/* The frozen copy, and only where it DIFFERS. A learner hits an error at 14:02 and opens
          this at 14:07, by which time the live snapshot describes a healthy session that is not the
          one being reported. The diff is frequently the whole investigation, and printing the
          fields that agree would bury it. */}
      {frozen ? <FrozenDiff live={live} atError={frozen} styles={styles} /> : null}
    </ScrollView>
  );
}

function FrozenDiff({
  live,
  atError,
  styles,
}: {
  live: SessionSnapshot;
  atError: SessionSnapshot;
  styles: ReturnType<typeof makeStyles>;
}) {
  const changed = (Object.keys(atError) as (keyof SessionSnapshot)[]).filter(
    (key) => JSON.stringify(atError[key]) !== JSON.stringify(live[key]),
  );
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>AT THE ERROR</Text>
      {changed.length === 0 ? (
        <Muted>Nothing has changed since — the state above is the state that failed.</Muted>
      ) : (
        changed.map((key) => (
          <Row key={key} label={key} value={`${json(atError[key])} → now ${json(live[key])}`} />
        ))
      )}
    </View>
  );
}

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, bad ? styles.rowValueBad : null]} selectable>
        {value}
      </Text>
    </View>
  );
}

// ── Send ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The one field a machine cannot produce, and the button that files it.
 *
 * Everything else in a report is generated. **"What were you doing and what did you expect" is the
 * only part a person supplies, and it is routinely the fastest route to the cause** — which is why
 * it is the first thing on this tab and the last thing the size cap will ever truncate.
 */
function SendTab({
  note,
  onNote,
  kind,
  onKind,
  includeTranscript,
  onIncludeTranscript,
  onFiled,
}: {
  note: string;
  onNote: (next: string) => void;
  kind: DebugReportKind | null;
  onKind: (next: DebugReportKind) => void;
  includeTranscript: boolean;
  onIncludeTranscript: (next: boolean) => void;
  onFiled: (outcome: SendOutcome) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const accessToken = useAccessToken();
  const session = useTutorSession();
  const events = useSyncExternalStore(subscribe, readEvents);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    // How many reports are already parked. Worth showing: a spool that is not draining is itself a
    // finding, and it is invisible everywhere else.
    let alive = true;
    void spooledCount().then((n) => {
      if (alive) setWaiting(n);
    });
    return () => {
      alive = false;
    };
  }, [outcome]);

  /**
   * `error` when the ring has one, `feedback` otherwise — and overridable, because a machine cannot
   * reliably tell "the tutor talks too fast" from "the tutor stopped talking". `kind` is the
   * operator page's first filter, so guessing it wrong costs a whole triage pass.
   */
  const hasError = events.some((e) => e.level === "error");
  const effectiveKind: DebugReportKind = kind ?? (hasError ? "error" : "feedback");

  // Built for the size readout, and rebuilt on send. Cheap — it is the ring plus two snapshots, and
  // this tab only renders while someone is looking at it.
  const preview = useMemo(
    () =>
      buildDebugReport({
        kind: effectiveKind,
        note,
        transcriptTail: includeTranscript ? session.lines.slice(-MAX_DEBUG_TRANSCRIPT_TAIL) : [],
      }),
    [effectiveKind, note, includeTranscript, session.lines],
  );
  const kb = Math.round(JSON.stringify(preview).length / 1024);

  return (
    <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
      <Muted>What happened, and what did you expect?</Muted>
      <TextField
        multiline
        value={note}
        onChangeText={onNote}
        placeholder="The tutor never said anything after I pressed Start…"
        style={{ marginTop: space.row, minHeight: 96 }}
      />

      <ChipRow style={{ marginTop: space.row }}>
        <Chip label="Problem" pressed={effectiveKind === "error"} onPress={() => onKind("error")} />
        <Chip
          label="Feedback"
          pressed={effectiveKind === "feedback"}
          onPress={() => onKind("feedback")}
        />
      </ChipRow>

      {/* OFF by default, and not out of squeamishness: including the transcript is REDUNDANT. The
          same lines are already stored server-side under this conversation id for this owner, and
          the operator page joins on it. The one case the toggle helps is a report about what the
          tutor SAID, filed while the conversation is still live and unsaved. */}
      <View style={{ marginTop: space.row }}>
        <View style={styles.checkRow}>
          <Checkbox
            checked={includeTranscript}
            onChange={onIncludeTranscript}
            accessibilityLabel="Include the last transcript lines"
          />
          <Muted>Include the last {MAX_DEBUG_TRANSCRIPT_TAIL} transcript lines</Muted>
        </View>
        <Faint style={{ marginTop: space.chipGap }}>
          Off by default — the transcript is already saved under this conversation.
        </Faint>
      </View>

      <Faint style={{ marginTop: space.row }}>
        {kb} KB · {preview.events.length} events
        {waiting > 0 ? ` · ${waiting} waiting to send` : ""}
      </Faint>

      <ButtonRow style={{ marginTop: space.row }}>
        <Button
          label={busy ? "Sending…" : "Send report"}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            setOutcome(null);
            void sendOrSpool(preview, accessToken)
              .then((next) => {
                // Both, in this order. `setOutcome` is what renders the failure below; `onFiled`
                // is what empties the composer and closes on a success, and it unmounts this tab
                // — so the state write has to have happened by then for the failure case to have
                // anything to show.
                setOutcome(next);
                onFiled(next);
              })
              .finally(() => setBusy(false));
          }}
        />
      </ButtonRow>

      {outcome?.kind === "dropped" ? <SendFailure /> : null}
    </ScrollView>
  );
}

/**
 * The only outcome that stays inside the modal.
 *
 * A dropped report is not retried and does not exist anywhere — so the composer keeps the note, the
 * modal stays open, and this sits under the button where the next Send press is. The two SUCCESS
 * outcomes close the modal, and are rendered by `DiagnosticsReceipt` on the surface behind it.
 */
function SendFailure() {
  return (
    <ErrorText style={{ marginTop: space.row }}>
      The server took the report and did not keep it. That is the hourly cap, or a report it
      refused — either way it will not be retried. Your note is still here.
    </ErrorText>
  );
}

/**
 * The receipt for a filed report, rendered by whoever hosts the modal — because the modal has by
 * then closed itself (`113f2603`).
 *
 * It exists so that closing does not throw away the one thing a learner has to carry out of here.
 * The `sent` case shows the id in the exact form to quote — `report 4f2a1c9e` — because the handoff
 * script takes that and nothing else, and §7.2 calls it "the useful part". The `spooled` case is
 * not an error and must not read like one: the report is safe on the device and will go on its own.
 *
 * `selectable`, like it was in the modal: the id is there to be read off a screen or copied out.
 */
export function DiagnosticsReceipt({ outcome }: { outcome: SendOutcome }) {
  if (outcome.kind === "sent") {
    return (
      <View>
        <Muted>Report sent. Quote this:</Muted>
        <Body selectable style={{ marginTop: space.chipGap }}>
          report {outcome.id?.slice(0, 8) ?? "?"}
        </Body>
      </View>
    );
  }
  if (outcome.kind === "spooled") {
    return (
      <Muted>Report saved on this device — it will send when you are back online.</Muted>
    );
  }
  return null;
}

// ── Log ──────────────────────────────────────────────────────────────────────────────────────

const FILTERS: { label: string; min: DebugLevel }[] = [
  { label: "all", min: "debug" },
  { label: "warn+", min: "warn" },
  { label: "error", min: "error" },
];

const RANK: Record<DebugLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * The ring, **newest first** — `use-event-log`'s argument, inherited verbatim: after a lock or a
 * failure you want what just happened at the top, not three minutes of scrolling away. (The
 * operator page will read it the other way round, because there you are reading a story rather than
 * checking what just happened.)
 *
 * A sequence gap is rendered explicitly. A report whose numbers jump is a report that dropped
 * events, and hiding that would make a truncated log look complete.
 */
function LogTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [min, setMin] = useState<DebugLevel>("debug");
  const [expanded, setExpanded] = useState<number | null>(null);

  // Subscribed only while this tab is mounted — the whole reason `readEvents` returns a stable
  // identity rather than a fresh array.
  const events = useSyncExternalStore(subscribe, readEvents);
  const shown = useMemo(
    () => events.filter((e) => RANK[e.level] >= RANK[min]).slice().reverse(),
    [events, min],
  );

  return (
    <View style={styles.body}>
      <ChipRow>
        {FILTERS.map((f) => (
          <Chip key={f.label} label={f.label} pressed={min === f.min} onPress={() => setMin(f.min)} />
        ))}
        <Faint>{events.length} events</Faint>
      </ChipRow>
      <ScrollView contentContainerStyle={styles.bodyContent}>
        {shown.length === 0 ? <Muted>Nothing at this level yet.</Muted> : null}
        {shown.map((e, i) => {
          const next = shown[i + 1];
          const gap = next ? e.seq - next.seq - 1 : 0;
          return (
            <View key={e.seq}>
              <EventRow event={e} expanded={expanded === e.seq} onPress={() => setExpanded(expanded === e.seq ? null : e.seq)} />
              {gap > 0 ? <Faint style={styles.gap}>— {gap} events dropped —</Faint> : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function EventRow({
  event,
  expanded,
  onPress,
}: {
  event: DebugEvent;
  expanded: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const tone =
    event.level === "error" ? styles.levelError : event.level === "warn" ? styles.levelWarn : styles.levelQuiet;
  return (
    <Pressable onPress={onPress} style={styles.event} accessibilityRole="button">
      <View style={styles.eventHead}>
        <Text style={[styles.eventCode, tone]}>{event.code}</Text>
        {/* Wall-clock on the left, relative on the right — the first lines an event up against a
            server log or against the moment the phone was locked, the second against the session. */}
        <Faint>{clock(event.at)} · {sign(event.since)}</Faint>
      </View>
      <Text style={styles.eventMessage} numberOfLines={expanded ? undefined : 2} selectable>
        {event.provider ? `[${event.provider}] ` : ""}
        {event.message}
      </Text>
      {expanded && event.data ? (
        <Text style={styles.eventData} selectable>
          {Object.entries(event.data)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join("\n")}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ── formatting ───────────────────────────────────────────────────────────────────────────────

/** Enough of a uuid to compare two of them by eye, which is the only thing this screen does with one. */
function short(id: string | null): string {
  return id === null ? "—" : `${id.slice(0, 8)}…`;
}

function tick(value: boolean): string {
  return value ? "✓" : "✗";
}

function json(value: unknown): string {
  if (value === null) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function clock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `+1.4s`, or `-0.3s` for the events that came BEFORE the session started — see `markSessionStart`. */
function sign(ms: number): string {
  const s = ms / 1000;
  return `${s >= 0 ? "+" : ""}${s.toFixed(1)}s`;
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: overlay.scrim, justifyContent: "center", padding: 16 },
    popup: {
      // Taller and wider than a `ConfirmDialog`: this one is a panel to read, not a question to
      // answer, and a log at dialog width is a log nobody scrolls.
      maxHeight: "88%",
      backgroundColor: t.panel,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.panel,
      padding: space.panelPadding,
    },
    header: { gap: space.row, marginBottom: space.row },
    title: { fontSize: 1.1 * 16, lineHeight: 1.1 * 16 * 1.4, fontWeight: type.weightBold, color: t.text },
    body: { flexShrink: 1 },
    bodyContent: { paddingBottom: space.row },
    actions: { justifyContent: "flex-end", marginTop: space.panelPadding },

    checkRow: { flexDirection: "row", alignItems: "center", gap: space.row },
    row: { marginBottom: space.row },
    rowLabel: { ...type.tiny, color: t.faint, fontWeight: type.weightSemibold },
    rowValue: { ...type.small, color: t.text },
    rowValueBad: { color: t.error, fontWeight: type.weightSemibold },

    section: { marginTop: space.row, paddingTop: space.row, borderTopWidth: 1, borderTopColor: t.border },
    sectionTitle: { ...type.tiny, color: t.warn, fontWeight: type.weightBold, marginBottom: space.row },

    event: {
      paddingVertical: space.chipGap,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    eventHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: space.row },
    eventCode: { ...type.tiny, fontWeight: type.weightSemibold },
    eventMessage: { ...type.small, color: t.text },
    eventData: {
      ...type.tiny,
      color: t.muted,
      marginTop: space.chipGap,
      padding: space.chipGap,
      backgroundColor: t.sunken,
      borderRadius: radius.item,
    },
    levelError: { color: t.error },
    levelWarn: { color: t.warn },
    levelQuiet: { color: t.muted },
    gap: { textAlign: "center", paddingVertical: space.chipGap },
  });
