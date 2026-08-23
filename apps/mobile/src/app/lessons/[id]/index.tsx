import {
  API_V2_ROUTES,
  isAgentVersionsResponse,
  isLessonDetailResponse,
  lessonPath,
  type AgentVersionsResponse,
  type LessonDetailResponse,
} from "@tutor/shared/api";
import { itemLine } from "@tutor/shared/lessons/types";
import type { LessonItem, LessonSession } from "@tutor/shared/lessons/types";
import { buildAddItemsOp, MAX_ITEMS } from "@tutor/shared/offline/ops";
import { clientDedupeKey } from "@tutor/shared/words/key";
import { type Palette } from "@tutor/shared/theme";
import type { TranscriptLine } from "@tutor/shared/tutor/session";
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { apiFetch } from "@/api";
import { useAccessToken } from "@/lib/auth";
import { clearSuggestionCache, fetchSuggestions } from "@/lib/suggestions";
import { newId } from "@/lib/ids";
import { fetchLessonItems, lessonTitleOrFallback, postOp } from "@/lib/lessons";
import {
  useActiveSession,
  useTutorControls,
  useTutorSession,
  type LessonMeta,
} from "@/lib/tutor-session";
import { useTheme } from "@/theme";
import {
  Autocomplete,
  type AutocompleteOption,
  Body,
  Button,
  ButtonRow,
  CloseIcon,
  ConfirmDialog,
  Disclosure,
  ErrorText,
  H1,
  Link,
  Muted,
  Panel,
  Screen,
  Select,
  space,
  type,
  useLoadingIndicator,
} from "@/ui";

/**
 * One lesson: its words, a live tutor session, and the history of past conversations.
 *
 * ## The session is not owned here any more
 *
 * It lives in `TutorSessionProvider` (`lib/tutor-session.tsx`), above the router, and this screen is
 * one of its views. That is a change of *ownership*, not of behaviour: the proactive kickoff, the
 * hidden-message filter, the per-conversation-id save guard, the carried transcript, the resume
 * context, the held pause and the lock-screen surfaces all moved across unchanged, with their
 * reasoning attached.
 *
 * What changed is what leaving does — **nothing**. The screen used to hang up on unmount, so
 * opening the collection, another lesson, or even this same lesson again killed the conversation
 * the learner was in the middle of, and re-entering looked like a resume while actually replaying a
 * truncated tail into a brand-new call. Now only End, the tutor, the network, or starting a
 * different lesson ends a session.
 *
 * The corollary is that the session on display may belong to a **different** lesson. `isOurs`
 * guards every read of it: a lesson that is not the one talking renders as idle, with a line saying
 * where the voice is coming from and a way back to it.
 *
 * ## What the design port changed
 *
 * **This screen absorbed `/lessons/:id/words`.** Editing was its own screen (S5 D51) for two
 * reasons: the transcript wanted the viewport, and `items_list` is baked into `dynamicVariables` at
 * connect, so an inline editor "would advertise an immediacy that does not exist". The first reason
 * is gone — the page is one scroll container now, so nothing has to own the viewport. The second is
 * still true, and it is true on the web too, where both have always been on one page. The honest
 * fix is neither a second screen nor silence: the panel says so.
 *
 * **The History panel is new.** `LessonDetailResponse.sessions` has always carried past
 * conversations *with their transcripts*, and this screen has always fetched them — it rendered
 * `sessionCount` and discarded the rest. The web has shown them since the beginning.
 *
 * See docs/2026-08-15-web-design-parity-on-mobile.md §8.6.
 */

/**
 * The empty transcript, as one shared array.
 *
 * A fresh `[]` per render would be a new identity every time, and the `useMemo` that concatenates
 * the transcript takes it as a dependency — so a screen showing another lesson's session would
 * rebuild its (empty) transcript on every one of that session's turns.
 */
const EMPTY_LINES: TranscriptLine[] = [];

type ItemEvent = { at: string; kind: "added" | "removed"; text: string };

function formatDuration(secs: number | null): string | null {
  if (secs == null) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function LessonScreen() {
  const { id: lessonId } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const accessToken = useAccessToken();

  // ── the lesson ─────────────────────────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<LessonDetailResponse | null>(null);
  const [versions, setVersions] = useState<AgentVersionsResponse | null>(null);
  const [items, setItems] = useState<LessonItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useLoadingIndicator(detail === null && loadError === null);

  /**
   * Three fetches, in parallel, on mount — and NOT the conversation token, which is minted at the
   * moment of connect (S3 D28): it lives 900 s and creates the conversation id with it, so fetching
   * it here would hand a stale one to a learner who read the word list first.
   *
   * `agent-versions` stays a separate call rather than a field on the lesson: it is not lesson data,
   * it changes on deploy rather than on edit, and folding it in would make every lesson read depend
   * on the agent registry.
   *
   * The items call is the third, and it is the one this screen gained with the merge. It returns
   * every item row INCLUDING removed ones, so the editable list is `removed_at === null` and the
   * change log is the same array flat-mapped into events — exactly how the web's page derives both
   * from its one `listLessonItemHistory` query. It is also the only route that carries item **ids**,
   * and `remove` needs one: `LessonDetail.items` is `string[]` (D44).
   */
  const load = useCallback(async () => {
    try {
      const [lesson, agents, itemRows] = await Promise.all([
        apiFetch<unknown>(lessonPath(lessonId), accessToken),
        apiFetch<unknown>(API_V2_ROUTES.agentVersions, accessToken),
        fetchLessonItems(accessToken, lessonId),
      ]);
      if (!isLessonDetailResponse(lesson)) throw new Error("Malformed lesson response.");
      setDetail(lesson);
      setItems(itemRows);
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

  // ── the words ──────────────────────────────────────────────────────────────────────────────
  const [itemsBusy, setItemsBusy] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** The add field's own outcome line — "added", "already here", "full". Errors use `itemsError`. */
  const [addFeedback, setAddFeedback] = useState<{ tone: "ok" | "warn"; message: string } | null>(
    null,
  );
  /**
   * What a failed write left behind: the optimistic state it wanted and the op that would produce
   * it. The ARGUMENTS rather than a closure over `writeItems`, because they are exactly what a
   * durable outbox would store when the mirror lands.
   */
  const retryRef = useRef<{ next: LessonItem[]; run: () => Promise<void> } | null>(null);
  /**
   * Which row is waiting on a confirmation. ONE dialog for the whole list, driven by this — the
   * pattern `ConfirmDialog` documents and `/lesson-items` already follows — rather than a mounted
   * dialog per word, which at `MAX_ITEMS` would be fifty modals in the tree to show none of them.
   */
  const [removeTarget, setRemoveTarget] = useState<LessonItem | null>(null);

  /** Active rows in display order — what the learner edits, and what the tutor will be given. */
  const active = useMemo(
    () =>
      (items ?? []).filter((i) => i.removed_at === null).sort((a, b) => a.position - b.position),
    [items],
  );

  /** Each row is an "added" event, and a removed one is also a "removed" event. Newest first. */
  const events = useMemo<ItemEvent[]>(
    () =>
      (items ?? [])
        .flatMap((it) => {
          const evs: ItemEvent[] = [{ at: it.created_at, kind: "added", text: it.text }];
          if (it.removed_at) evs.push({ at: it.removed_at, kind: "removed", text: it.text });
          return evs;
        })
        .sort((a, b) => (a.at < b.at ? 1 : -1)),
    [items],
  );

  /** Optimistic apply, then re-read; snapshot back on failure and keep the op for a retry (§3.2). */
  const writeItems = useCallback(
    async (next: LessonItem[], run: () => Promise<void>): Promise<boolean> => {
      if (itemsBusy) return false;
      const snapshot = items;
      setItemsBusy(true);
      setItemsError(null);
      setItems(next);
      try {
        await run();
        retryRef.current = null;
        await load();
        return true;
      } catch (e) {
        setItems(snapshot);
        retryRef.current = { next, run };
        setItemsError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setItemsBusy(false);
      }
    },
    [itemsBusy, items, load],
  );

  const atCap = active.length >= MAX_ITEMS;

  /**
   * The dedupe keys of everything already in this lesson, so a suggestion can say so before it is
   * tapped.
   *
   * `clientDedupeKey` and not something local: it is the exact key `planNewItems` will use to
   * decide whether this word is a duplicate, so the marker on the row and the behaviour of the
   * button cannot disagree. It is deliberately weaker than the Postgres identity — it may fail to
   * mark a word the server would merge, never the reverse (see the invariant in `word-key.ts`),
   * which is the safe direction: an unmarked duplicate is caught by `buildAddItemsOp` and reported.
   */
  const activeKeys = useMemo(
    () => new Set(active.map((item) => clientDedupeKey(item.text))),
    [active],
  );

  /**
   * Prefix suggestions for the add field — the same lexicon the collection's Add-a-word box uses.
   *
   * Memoised because `Autocomplete` re-runs its debounce effect whenever `search` changes identity:
   * an inline arrow would restart the timer on every keystroke's render and the request would never
   * fire. `activeKeys` is in the dependency list and is safe there — it changes when the lesson's
   * items change, which cannot happen while the learner is mid-word.
   *
   * `marked` means "already in THIS LESSON", not the `owned` flag the API returns ("already in your
   * collection"). On this screen the collection is not the thing the learner is editing, and a word
   * they own but have not put in this lesson is exactly what they came here to add — marking it
   * would warn them off the correct action.
   */
  const searchWords = useCallback(
    async (query: string): Promise<AutocompleteOption[]> => {
      const suggestions = await fetchSuggestions(accessToken, query);
      return suggestions.map((s) => ({
        key: s.text,
        label: s.text,
        badge: s.level,
        // Up to three glosses come back; two is what fits at phone width.
        detail: s.ru.slice(0, 2).join(", "),
        marked: activeKeys.has(clientDedupeKey(s.text)),
      }));
    },
    [accessToken, activeKeys],
  );

  /**
   * Add ONE word to this lesson, from the suggestion field.
   *
   * The write path is unchanged and deliberately so: `buildAddItemsOp` → `postOp`, i.e. the outbox
   * algebra, which is what attaches the word to the lesson. The collection's own `addWord` route
   * looks like the same action and is not — it creates a word in NO lesson, which on this screen
   * would add nothing to the list the learner is looking at.
   *
   * `buildAddItemsOp` owns the whole rule: normalize, drop blanks, drop anything already active,
   * and number what survives from `max(position) + 1` — a removed item leaves a gap and reusing its
   * position would collide. A `null` op therefore means "already in this lesson", which is now
   * SAID rather than swallowed: with a bulk textarea a silently-skipped duplicate was one line of
   * several, but when the learner adds one word at a time an empty response reads as a dead button.
   */
  async function addWordToLesson() {
    if (!items) return;
    const text = draft.trim();
    if (!text) {
      setAddFeedback({ tone: "warn", message: "Type a word first." });
      return;
    }
    if (atCap) {
      setAddFeedback({ tone: "warn", message: `This lesson is full (${MAX_ITEMS} items).` });
      return;
    }
    const op = buildAddItemsOp(lessonId, [text], active, newId);
    if (!op) {
      setAddFeedback({ tone: "warn", message: `“${text}” is already in this lesson.` });
      setDraft("");
      return;
    }

    const at = new Date().toISOString();
    const optimistic: LessonItem[] = op.items.map((it) => ({
      id: it.id,
      // Both null, and neither is a placeholder to be filled in later on the client. Word identity
      // needs Postgres (`resolve_words`, unaccent + NFKC), and the translation is written by the
      // enrichment job well after the write — so a just-added word is a row that renders as plain
      // text with no Russian until `writeItems`' re-read, one round trip from now.
      wordId: null,
      text: it.text,
      translationRu: null,
      position: it.position,
      created_at: at,
      removed_at: null,
    }));
    setDraft("");
    setAddFeedback(null);
    const landed = await writeItems([...items, ...optimistic], () => postOp(accessToken, op));
    // A failed write already shows itself through `itemsError` and its Retry, and the optimistic
    // row has been rolled back — claiming "Added" on top of that would be the screen contradicting
    // itself.
    if (!landed) return;
    // The suggestion buckets carry an `owned` flag per row and one of those rows may have just
    // become owned: a word added to a lesson is a `words` row the learner now has. Dropping the
    // cache costs a ~7 KB refetch on the next word and cannot be subtly wrong.
    clearSuggestionCache();
    setAddFeedback({ tone: "ok", message: `Added “${op.items[0]?.text ?? text}”.` });
  }

  async function removeItem(item: LessonItem) {
    if (!items) return;
    const at = new Date().toISOString();
    // Marked removed rather than dropped: the row IS the history, so the change log updates with it.
    const next = items.map((i) => (i.id === item.id ? { ...i, removed_at: at } : i));
    await writeItems(next, () =>
      postOp(accessToken, { kind: "removeItem", lessonId, itemId: item.id }),
    );
  }

  // ── the session ────────────────────────────────────────────────────────────────────────────
  const session = useTutorSession();
  const {
    focusLesson,
    syncMeta,
    start,
    end,
    hold,
    release,
    toggleMute,
    discardParked,
    chooseVersion,
  } = useTutorControls();

  /**
   * Is the session on display this lesson's?
   *
   * Every read below goes through it. There is one session for the whole app, and while it is
   * running it belongs to one lesson — so a screen that is not that lesson must render as idle
   * rather than as a second set of controls for someone else's conversation.
   */
  const isOurs = session.lessonId === lessonId;
  const connected = isOurs && session.connected;
  const busy = isOurs && session.busy;
  const ending = isOurs && session.ending;
  const held = isOurs && session.held;
  const isMuted = isOurs && session.muted;
  const silenced = !isOurs || session.silenced;
  const pause = isOurs ? session.pause : null;
  const error = isOurs ? session.error : null;
  const lines = isOurs ? session.lines : EMPTY_LINES;
  const carried = isOurs ? session.carried : EMPTY_LINES;
  const selectedVersion = (isOurs ? session.version : null) ?? versions?.defaultVersion ?? null;
  /**
   * Which service the chosen version runs on. Looked up rather than stored beside the selection,
   * because the version IS the choice (§13 Q1/Q2 of
   * docs/2026-08-22-openai-realtime-second-provider.md) and a second piece of state would be a
   * second thing that can disagree with it.
   *
   * `null` before `/api/v2/agent-versions` answers, exactly like `selectedVersion` — they are one
   * decision and they become known together.
   */
  const selectedProvider =
    versions?.versions.find((v) => v.version === selectedVersion)?.provider ?? null;

  /**
   * Another lesson has the microphone.
   *
   * From `useActiveSession` rather than from `session` above, because it carries the other lesson's
   * TITLE — naming it is the difference between "something else is using the microphone" and a
   * sentence the learner can act on.
   */
  const running = useActiveSession();
  const elsewhere = running && running.lessonId !== lessonId ? running : null;

  /**
   * Claim the session state for this lesson.
   *
   * Refused while another lesson is connected — that refusal is the whole feature — which is why
   * this re-runs on `session.lessonId` and `session.connected`: the claim then lands by itself the
   * moment the other session ends, rather than leaving this screen stuck showing nothing.
   * `focusLesson` returns immediately when the lesson is already focused, so re-running is free.
   */
  useEffect(() => {
    focusLesson(lessonId);
  }, [focusLesson, lessonId, session.lessonId, session.connected]);

  // ── the lock-screen surfaces ───────────────────────────────────────────────────────────────
  /**
   * What the card shows. Computed here because this is where the lesson is loaded, and pushed at the
   * provider, which owns the card itself — the projection rules and the "Swift decides nothing" rule
   * live there (see `lib/tutor-session.tsx` and
   * docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md).
   */
  const activityWords = useMemo(() => active.map(itemLine), [active]);
  /**
   * Built here, not in Swift: the scheme is per-variant (englishtutordev / …preview / …) and
   * expo-linking already knows which one this build is. §3.6.
   */
  const activityDeepLink = useMemo(() => Linking.createURL(`lessons/${lessonId}`), [lessonId]);
  const lessonMeta = useMemo<LessonMeta>(
    () => ({
      // The same fallback the screen heading uses, so a lesson with no title is named the same way
      // in both places rather than "Untitled lesson" here and "Lesson" on the card.
      title: lessonTitleOrFallback(detail?.lesson.title ?? ""),
      deepLink: activityDeepLink,
      words: activityWords,
    }),
    [detail?.lesson.title, activityDeepLink, activityWords],
  );

  /** Ignored for a lesson that is not the focused one — a word added here must not re-point a card
   *  that belongs to the lesson currently talking. */
  useEffect(() => {
    syncMeta(lessonId, lessonMeta);
  }, [syncMeta, lessonId, lessonMeta]);

  /**
   * Refetch when a transcript of ours reaches the server.
   *
   * The provider used to be this screen and simply called `load()`. It cannot now — it runs above
   * the router and this screen may not even be mounted when a session is saved — so it publishes
   * the fact and this reacts to it. The ref starts at whatever is already published so that a save
   * from before this mount does not trigger a second load on top of the one `load` does anyway.
   */
  const seenPersistRef = useRef(session.lastPersisted?.at ?? 0);
  useEffect(() => {
    const stamp = session.lastPersisted;
    if (!stamp || stamp.lessonId !== lessonId || stamp.at === seenPersistRef.current) return;
    seenPersistRef.current = stamp.at;
    void load();
  }, [session.lastPersisted, lessonId, load]);

  /**
   * Start — or take the session over from whichever lesson currently has it.
   *
   * The takeover is deliberate and it is the ONE navigation-shaped act that ends a conversation:
   * pressing Start on a lesson is an unambiguous request for *this* lesson's voice. The provider
   * saves and parks the outgoing one on the way out, so nothing is lost by it.
   */
  const startHere = useCallback(() => {
    if (!detail || busy) return;
    void start({
      lessonId,
      meta: lessonMeta,
      itemsDetailed: detail.lesson.itemsDetailed,
      version: selectedVersion,
      provider: selectedProvider,
    });
  }, [busy, detail, lessonId, lessonMeta, selectedVersion, selectedProvider, start]);

  // ── render ─────────────────────────────────────────────────────────────────────────────────
  const transcript = useMemo(() => carried.concat(lines), [carried, lines]);
  /**
   * One line, four states. A paused session is `disconnected` at the transport, so reporting the
   * raw status there would say "status: disconnected" to someone looking at a Resume button.
   *
   * Pause and mute get DIFFERENT sentences on purpose. They look alike from outside — both stop the
   * learner being heard — and the thing that separates them is invisible: only a pause runs the
   * heartbeat that stops the tutor re-engaging. So the line has to carry it. §3.4.
   */
  const statusLine = held
    ? // "muted", never "off": muting reaches LiveKit's `track.mute()`, which releases the capture
      // device only when the track was published with `stopMicTrackOnMute` — and the ElevenLabs SDK
      // builds its Room without it. The microphone is silent but still open, and iOS says so with
      // the indicator. See docs/2026-08-16-tutor-pause-hold-the-line.md §4.2.
      //
      // The second variant is the tripwire for the day an SDK upgrade closes the escape hatch that
      // silences the tutor (§4.4): the pause still works, it just cannot promise quiet, and saying
      // so beats the learner discovering it through the speaker.
      silenced
      ? "⏸ paused — microphone muted, the tutor is waiting"
      : "⏸ paused — microphone muted, but the tutor may still be audible"
    : connected
      ? isMuted
        ? // The tutor is NOT waiting — it has no heartbeat holding it off, so it will re-engage
          // into the silence after `turn_timeout`. Saying "the tutor can still hear itself out" is
          // the honest version of that, and it is the difference from a pause. §3.4.
          "🎤 muted — the tutor keeps going; unmute to answer"
        : "● listening — just talk to interrupt"
      : pause === "paused"
        ? "⏸ paused — resume when you're ready"
        : elsewhere
          ? // The one status this screen reports about a session that is not its own. Without it the
            // line would read "status: disconnected" next to a Start button that is about to end
            // someone else's conversation.
            `“${elsewhere.title}” is using the microphone`
          : `status: ${isOurs ? session.status : "disconnected"}`;
  /**
   * ONE picker, and it chooses the service.
   *
   * A service control was briefly built beside this one and then removed, because the registry made
   * it redundant rather than helpful: both versions run the same lesson, so the list is already a
   * list of services and the labels say so ("1.0 · ElevenLabs", "2.0 · ChatGPT"). Two controls over
   * one decision is a second thing that can look wrong.
   *
   * Picking a version IS picking a provider (§13 Q1/Q2) — `selectedProvider` above is looked up from
   * this choice, never stored beside it.
   */
  const versionOptions = useMemo(
    () => (versions?.versions ?? []).map((v) => ({ value: v.version, label: v.label })),
    [versions],
  );

  if (loadError) {
    return (
      <Screen>
        <Muted>
          <Link href="/lessons">← all lessons</Link>
        </Muted>
        <Panel tone="error">
          <ErrorText>{loadError}</ErrorText>
          <ButtonRow style={{ marginTop: space.row }}>
            <Button variant="secondary" label="Try again" onPress={() => void load()} />
          </ButtonRow>
        </Panel>
      </Screen>
    );
  }

  if (!detail) {
    return (
      <Screen>
        <Muted>
          <Link href="/lessons">← all lessons</Link>
        </Muted>
        <ActivityIndicator color={theme.accent} style={{ marginTop: 24 }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <H1>{lessonTitleOrFallback(detail.lesson.title)}</H1>
      <Muted>
        Created {new Date(detail.lesson.created_at).toLocaleDateString()} ·{" "}
        <Link href="/lessons">← all lessons</Link>
      </Muted>

      {/* ── Words ──────────────────────────────────────────────────────────────────────────── */}
      {/* `zIndex` because the suggestion popup is an absolute overlay that hangs out of this
          panel's bottom edge, and `zIndex` only orders SIBLINGS — so the panel itself has to
          outrank the Practice panel and everything after it, or the overlay renders behind them.
          Setting it on the popup alone does nothing across this boundary. Same reason, same
          number, as the collection's Add-a-word panel. */}
      <Panel title="Words in this lesson" style={{ zIndex: 10 }}>
        {items === null ? (
          <ActivityIndicator color={theme.accent} />
        ) : active.length === 0 ? (
          <Muted>No words yet — add some below.</Muted>
        ) : (
          active.map((item, index) => (
            <WordRow
              key={item.id}
              item={item}
              index={index}
              disabled={itemsBusy}
              onRemove={setRemoveTarget}
            />
          ))
        )}

        {/* The collection's Add-a-word field, writing to this lesson instead of to no lesson.
            It replaced a multiline "one per line" box, which is why bulk paste is gone: the ask was
            the suggestion list, and a textarea cannot have one — there is no single word to
            complete. See docs/2026-08-21-add-word-with-suggestions-on-lesson-page.md §2. */}
        <View style={[styles.addRow, { marginTop: space.panelGap }]}>
          <Autocomplete
            value={draft}
            onChangeText={setDraft}
            search={searchWords}
            markedLabel="Already in this lesson"
            // 7,226 lexicon rows are unlevelled and plenty of real words are outside it
            // altogether, so "no matches" must not read as "that is not a word". A lesson also
            // holds phrases and whole sentences, which the dictionary never will.
            emptyLabel="Not in the dictionary — you can still add it."
            placeholder="A word, phrase, or sentence"
            returnKeyType="done"
            editable={!atCap}
            onSubmitEditing={() => void addWordToLesson()}
            accessibilityLabel="A word, phrase, or sentence to add to this lesson"
            style={{ flex: 1 }}
          />
          <Button
            label={itemsBusy ? "Adding…" : "Add"}
            disabled={atCap || itemsBusy}
            onPress={() => void addWordToLesson()}
          />
        </View>

        {addFeedback ? (
          <Muted
            accessibilityLiveRegion="polite"
            style={[
              { marginTop: space.row },
              addFeedback.tone === "ok" ? styles.added : styles.removed,
            ]}
          >
            {addFeedback.message}
          </Muted>
        ) : (
          <Muted style={{ marginTop: space.row }}>
            {atCap ? `This lesson is full (${MAX_ITEMS} items).` : `${active.length}/${MAX_ITEMS} items`}
          </Muted>
        )}

        {/* The caveat that made editing its own screen (D51). It is true on the web too, which has
            simply never said it — `items_list` is baked into `dynamicVariables` at connect. */}
        <Muted style={{ marginTop: space.row }}>Changes apply to your next conversation.</Muted>

        {itemsError ? (
          <>
            <ErrorText style={{ marginTop: space.row }}>{itemsError}</ErrorText>
            <ButtonRow style={{ marginTop: space.row }}>
              <Button
                variant="secondary"
                label="Retry"
                disabled={itemsBusy}
                onPress={() => {
                  const again = retryRef.current;
                  if (again) void writeItems(again.next, again.run);
                }}
              />
            </ButtonRow>
          </>
        ) : null}
      </Panel>

      {/* ── Practice ───────────────────────────────────────────────────────────────────────── */}
      <Panel title="Practice">
        <Muted>Press start and discuss the words out loud with the tutor. Interrupt any time.</Muted>

        {/* A conversation is running somewhere else. Said plainly, with the way to it — because the
            alternative is a Start button that silently hangs up a lesson the learner is still in
            the middle of, on a screen that gave no hint one was running. Starting here is still
            allowed: it is an unambiguous request for THIS lesson's voice, and the outgoing session
            is saved and parked on the way out. */}
        {elsewhere ? (
          <Panel tone="warn" style={{ marginTop: space.row }}>
            <Body>
              {elsewhere.held ? "Paused" : "In progress"}: “{elsewhere.title}”. Starting here will
              end it.
            </Body>
            <ButtonRow style={{ marginTop: space.row }}>
              <Button
                variant="secondary"
                label={`Back to “${elsewhere.title}”`}
                onPress={() => router.push(`/lessons/${elsewhere.lessonId}`)}
              />
            </ButtonRow>
          </Panel>
        ) : null}

        {versionOptions.length > 1 ? (
          <View style={styles.versionRow}>
            <Muted>Tutor</Muted>
            <Select
              label="Tutor"
              value={selectedVersion ?? versionOptions[0]?.value ?? ""}
              onValueChange={chooseVersion}
              options={versionOptions}
              disabled={connected || busy}
            />
          </View>
        ) : null}

        {/* Three slots, always in the same order, so a control never moves under the thumb that is
            reaching for it: the session verb, the pause verb, the microphone. The layout is the one
            the lock-screen card will mirror — see docs/2026-08-16-background-controls-lock-screen.md
            §5.4 — and building it here first is deliberate: this row is where the state machine
            behind those three buttons gets to be wrong somewhere visible.

            Slots two and three empty out rather than disable when there is nothing to control. A
            disabled Pause on a lesson that has not started advertises a control the learner cannot
            reach; an absent one says the same thing without inviting the tap. */}
        <ButtonRow style={{ marginTop: space.row }}>
          {connected ? (
            // Hangs up FIRST and persists after — see `endWithPersist` for why the old ordering
            // made this button do nothing on a slow network. There is no confirm: the learner can
            // see what they are ending, which is exactly the thing a locked device cannot offer
            // (§3.5), and End has not been reachable from the lock screen since 2026-08-18.
            <Button
              label={ending ? "Ending…" : "End session"}
              disabled={ending}
              onPress={end}
            />
          ) : (
            <Button
              label={busy ? "Connecting…" : "Start conversation"}
              disabled={busy}
              onPress={() => {
                // Fresh, always — and it has to say so, because the Resume button beside it calls
                // the same `start()`. The only difference between the two controls is this line.
                discardParked(lessonId);
                startHere();
              }}
            />
          )}
          {connected ? (
            <Button
              variant="secondary"
              label={held ? "Resume" : "Pause"}
              onPress={held ? release : hold}
            />
          ) : pause === "paused" ? (
            // The parked pause — the line was taken while the learner was away. Resuming it is a
            // NEW conversation handed the old one's tail, which is the lossy path; it exists as the
            // floor under the held pause, not as the pause. This is the ONE button that carries
            // that tail; its neighbour deliberately throws it away.
            <Button variant="secondary" label="Resume" disabled={busy} onPress={startHere} />
          ) : null}
          {/* Hidden during a hold, not disabled: the pause already owns the microphone, so the only
              thing this button could offer there is an unmute the app would have to refuse. */}
          {connected && !held ? (
            <Button
              variant="secondary"
              label={isMuted ? "Unmute" : "Mute"}
              onPress={toggleMute}
            />
          ) : null}
        </ButtonRow>

        {/* Its own line, below the buttons. It used to sit beside them, where a two-button row
            leaves it no width and it wraps under half a button anyway. */}
        <Muted style={{ marginTop: space.row }}>{statusLine}</Muted>

        {error ? <ErrorText style={{ marginTop: space.row }}>{error}</ErrorText> : null}
      </Panel>

      {/* ── Live transcript ────────────────────────────────────────────────────────────────── */}
      {transcript.length > 0 ? (
        <Panel title="Live transcript">
          {transcript.map((line, i) => (
            <Line key={i} line={line} />
          ))}
        </Panel>
      ) : null}

      {/* ── Word changes ───────────────────────────────────────────────────────────────────── */}
      {events.length > 0 ? (
        <Panel>
          <Disclosure
            summary={
              <Body>
                <Text style={styles.strong}>Word changes</Text>{" "}
                <Text style={styles.muted}>
                  — {events.length} {events.length === 1 ? "event" : "events"}
                </Text>
              </Body>
            }
          >
            {events.map((e, i) => (
              <Body key={i} style={styles.logLine}>
                <Text style={e.kind === "added" ? styles.added : styles.removed}>
                  {e.kind === "added" ? "＋ added" : "－ removed"}
                </Text>{" "}
                <Text style={styles.strong}>{e.text}</Text>{" "}
                <Text style={styles.muted}>— {new Date(e.at).toLocaleString()}</Text>
              </Body>
            ))}
          </Disclosure>
        </Panel>
      ) : null}

      {/* ── History ────────────────────────────────────────────────────────────────────────── */}
      <Panel title="History">
        {detail.sessions.length === 0 ? (
          <Muted>No conversations yet — start one above and it will appear here.</Muted>
        ) : (
          <>
            {/* A cap the client cannot see is a cap that lies (`MAX_LESSON_SESSIONS`). */}
            {detail.sessionCount > detail.sessions.length ? (
              <Muted style={{ marginBottom: space.row }}>
                Showing {detail.sessions.length} of {detail.sessionCount} conversations.
              </Muted>
            ) : null}
            {detail.sessions.map((session) => (
              <SessionEntry key={session.id} session={session} />
            ))}
          </>
        )}
      </Panel>

      {/*
        The copy REASSURES where the collection's delete dialog warns, and the difference is the
        point — the same difference the two existing dialogs already draw between themselves.
        `/lesson-items` has to say a word "leaves every lesson and loses its practice history",
        because `deleteWord` really does that. This removes one `lesson_items` row: the word keeps
        its place in the collection, its statistics and every other lesson, and the removed row
        survives as the "Word changes" entry below. Nothing here is unrecoverable, so nothing here
        should read as though it were.
      */}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={removeTarget ? `Remove “${removeTarget.text}” from this lesson?` : ""}
        description="It stays in your collection with its practice history, and you can add it back any time."
        confirmLabel="Remove"
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (target) void removeItem(target);
        }}
      />
    </Screen>
  );
}

/**
 * One word of the lesson: its number, its spelling as a link to the word page, its Russian, and the
 * ✕ that takes it out of this lesson.
 *
 * **The number and the translation are `itemLine`'s job, not this file's.** The lock-screen card
 * renders the same pair, and the two drifting apart — one saying "word — перевод" and the other
 * "word (перевод)" — is exactly the class of thing `packages/shared` exists to prevent. What stays
 * here is the *typography* of it, which the widget extension cannot share anyway: the word carries
 * the weight, the Russian recedes.
 *
 * `wordId` is null for the round trip between an optimistic add and its re-read, and the row is
 * plain text for exactly that long. A link to `/lesson-items/null` would be a dead tap, and the
 * only thing worse than a word that is not yet a link is one that pretends to be.
 */
const WordRow = memo(function WordRow({
  item,
  index,
  disabled,
  onRemove,
}: {
  item: LessonItem;
  index: number;
  disabled: boolean;
  /**
   * Takes the item rather than closing over it, so the parent can pass `setRemoveTarget` itself.
   *
   * The obvious `onRemove={() => setRemoveTarget(item)}` allocates a fresh closure on every parent
   * render and makes the `memo` below decorative — and the parent re-renders on every transcript
   * turn (`onMessage` → `setLines`), so during a live session all fifty possible rows would redraw
   * several times a minute to change nothing.
   */
  onRemove: (item: LessonItem) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View style={styles.wordRow}>
      <Muted style={styles.wordIndex}>{index + 1}.</Muted>
      <Body style={{ flex: 1 }}>
        {item.wordId ? (
          // `plain`, not `accent`: a panel of six accent-blue words reads as a link farm, and the
          // web makes the same call for a lesson title that is a link but reads as content.
          <Link href={`/lesson-items/${item.wordId}`} variant="plain">
            <Text style={styles.strong}>{item.text}</Text>
          </Link>
        ) : (
          <Text style={styles.strong}>{item.text}</Text>
        )}
        {item.translationRu ? (
          <Text style={styles.muted}> — {item.translationRu}</Text>
        ) : null}
      </Body>
      {/* `hitSlop` is small on purpose, as it is on the collection's row: its neighbour is the word
          itself, which is a link, and generous slop would trade a missed tap for a removed word. */}
      <Button
        variant="icon"
        tone="danger"
        hitSlop={4}
        disabled={disabled}
        onPress={() => onRemove(item)}
        accessibilityLabel={`Remove ${item.text} from this lesson`}
      >
        <CloseIcon size={16} color={theme.error} />
      </Button>
    </View>
  );
});

function SessionEntry({ session }: { session: LessonSession }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const meta = [
    new Date(session.created_at).toLocaleString(),
    session.agent_version,
    formatDuration(session.duration_secs),
    `${session.transcript.length} turns`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Disclosure
      style={styles.sessionRow}
      summary={
        <Body>
          <Text style={styles.strong}>Conversation</Text>{" "}
          <Text style={styles.muted}>— {meta}</Text>
        </Body>
      }
    >
      {session.summary ? <Muted style={styles.summary}>{session.summary}</Muted> : null}
      {session.transcript.map((line, i) => (
        <Line key={i} line={line} />
      ))}
    </Disclosure>
  );
}

/**
 * One transcript turn. Memoised because every live line re-renders this screen — the combined
 * `useConversation` hook is deliberately kept for the port (D37), and splitting its hooks is an
 * optimisation to make with a measurement.
 */
const Line = memo(function Line({ line }: { line: TranscriptLine }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Body style={styles.line}>
      <Text style={line.role === "agent" ? styles.agent : styles.you}>
        {line.role === "agent" ? "Teacher" : "You"}:{" "}
      </Text>
      <Text style={styles.muted}>{line.text}</Text>
    </Body>
  );
});

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wordRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 0.75 * 16,
      paddingVertical: 0.25 * 16,
    },
    /** The `1.` gutter. Fixed width so the words line up however far the list counts. */
    wordIndex: { width: 1.4 * 16 },
    addRow: { flexDirection: "row", alignItems: "center", gap: space.row },
    versionRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: space.row,
      marginTop: space.row,
    },
    line: { marginBottom: space.row },
    agent: { color: t.accent, fontWeight: type.weightBold },
    you: { color: t.ok, fontWeight: type.weightBold },
    muted: { ...type.small, color: t.muted },
    strong: { fontWeight: type.weightBold },
    logLine: { marginBottom: 0.35 * 16 },
    added: { color: t.ok },
    removed: { color: t.error },
    sessionRow: { borderBottomWidth: 1, borderBottomColor: t.border },
    summary: { fontStyle: "italic", marginBottom: space.row },
  });
