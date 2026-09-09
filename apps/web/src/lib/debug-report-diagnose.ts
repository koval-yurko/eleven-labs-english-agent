import type { DebugEvent, SessionSnapshot } from "@tutor/shared/debug/report";

/**
 * The pairs of fields in a session snapshot that must agree, and what it means when they do not.
 *
 * ## Why this is one module and not two copies
 *
 * Two things read a snapshot: the operator page (`/ops/reports/[id]`) and the handoff script
 * (`pnpm report`). If each carried its own idea of "what looks wrong", they would drift — and the
 * failure would be silent and specific: the page and the terminal disagreeing about the same row,
 * with no way to tell which one was behind.
 *
 * ## Why it is here and not in `packages/shared`
 *
 * `CLAUDE.md`'s test: *if this had a bug, could I fix it by deploying the web app alone?* Both
 * consumers are in `apps/web`, so yes. The `SessionSnapshot` SHAPE is shared because the phone
 * writes it; the reading of it is not.
 *
 * ## What belongs in here
 *
 * Every entry is a hazard with a docblock in `apps/mobile/src/lib/tutor-session.tsx` — a state the
 * session was specifically designed against and that no screen can show. Stating them as sentences
 * is what stops reading a report requiring you to already know them.
 *
 * ## They are HEURISTICS, and the wording has to say so
 *
 * A snapshot is one moment with no event ordering in it, so these cannot know what happened after
 * the freeze. `starting` legitimately makes `owns` false for a beat during a takeover; a focus that
 * moved *after* the error will look, in a snapshot, exactly like a conversation filed under the
 * wrong lesson.
 *
 * That last case is not hypothetical: a fresh reader given a report where it fired was led toward a
 * mis-filing bug that had not happened, and only got to the real cause by discarding this section
 * and reading the timeline.
 *
 * ## So the ring is passed in, and a rule that the timeline REFUTES does not print
 *
 * Softening the wording was the first repair and it was not enough. The second reader's verdict was
 * exact: *"the section even tells you to check the ordering, which means it knows it's guessing —
 * but it still spends a paragraph on a hypothesis it could have resolved itself from data it
 * already has."*
 *
 * It is right. The ordering is in the ring, in the same document. A heuristic that hedges when it
 * could simply check is asking the reader to do work the machine can do — and it costs them a wrong
 * first hypothesis, which is the most expensive kind. So `events` is optional (a snapshot with no
 * ring still gets the hedged wording) and, when supplied, a rule the timeline settles either states
 * the settled answer or stays quiet.
 */

/** The `since` of the first error-level event — the moment the snapshot was frozen at. */
function firstErrorAt(events: DebugEvent[]): number | null {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return ordered.find((e) => e.level === "error")?.since ?? null;
}
export function diagnoseSnapshot(s: SessionSnapshot, events: DebugEvent[] = []): string[] {
  const found: string[] = [];
  const errorAt = firstErrorAt(events);

  if (s.conversationLesson !== null && s.conversationLesson !== s.focusedLesson) {
    /**
     * Settled against the ring rather than hedged, when the ring is here.
     *
     * A `session.focus` that lands AFTER the failure cannot have mis-filed anything — the write had
     * already been attempted — so the rule reports itself ruled out instead of printing a
     * hypothesis the reader then has to disprove. Only a focus change that could have preceded the
     * write is worth their attention.
     */
    const focusMovedAfter = events.some((e) => e.code === "session.focus" && errorAt !== null && e.since > errorAt);
    if (focusMovedAfter) {
      found.push(
        `The conversation belonged to lesson ${s.conversationLesson} while ${s.focusedLesson ?? "no lesson"} is focused — but the timeline shows \`session.focus\` moving AFTER the failure, so nothing was mis-filed. **Ruled out.**`,
      );
    } else {
      found.push(
        `The conversation belongs to lesson ${s.conversationLesson} while ${s.focusedLesson ?? "no lesson"} was focused. If the focus moved BEFORE the transcript was written, it was filed under the wrong lesson and is not recoverable.${events.length === 0 ? " Check the order of `session.focus` and `persist.*` in the timeline." : ""}`,
      );
    }
  }
  // `starting` is the takeover half-beat: one conversation has been hung up and the next is being
  // minted, and `owns` is legitimately false there. Excluding it is what keeps this from firing on
  // every single start.
  if (s.status === "connected" && !s.owns && !s.starting) {
    found.push(
      "Connected, but this session does not own the conversation — turns would land in someone else's transcript and the kickoff would fire twice.",
    );
  }
  if (s.lines > 0 && s.conversationId !== null && s.savedFor !== s.conversationId) {
    found.push(
      s.savedFor === null
        ? `${s.lines} lines were collected under conversation ${s.conversationId} and nothing had been saved yet (\`savedFor\` is empty) — the transcript may never have reached the server.`
        : `${s.lines} lines were collected under conversation ${s.conversationId}, but the most recent successful save was for a different conversation (${s.savedFor}) — this one may never have reached the server.`,
    );
  }
  if (s.held && !s.silenced) {
    found.push(
      "Paused, but the tutor could not be silenced — it was still audible to a learner who had stepped away.",
    );
  }
  if (s.held && s.capabilities?.userActivity && !s.heartbeat) {
    found.push(
      "A held pause on a provider whose turn timer needs a keep-alive, with no heartbeat running — the platform would have ended the call.",
    );
  }
  if (s.status === "connected" && !s.kickedOff) {
    found.push(
      "Connected but never kicked off — the tutor would never have opened its mouth. (`WebRTCConnection.sendMessage` drops anything sent before `RoomEvent.Connected` with a console warning and no error.)",
    );
  }
  if (s.resumeLines > 0 && s.kickedOff) {
    found.push(
      `${s.resumeLines} lines were still waiting to be handed over as resume context after the kickoff had already fired — the tutor started fresh on a conversation that was meant to continue.`,
    );
  }
  return found;
}

/**
 * The order an investigation reads a snapshot in — build outward, then the machine, then the pause.
 *
 * Needed because `Object.keys` on a snapshot that came back out of Postgres does NOT give the order
 * it was written in: `jsonb` normalises keys by length and then bytewise, so a raw iteration renders
 * `held, owns, lines, muted, usage, status, carried…` — every field present, none of them near the
 * one it should be compared against. `focusedLesson` and `conversationLesson` are the pair that
 * matters most and they land twenty rows apart.
 *
 * §7.2 already fixed this order for the phone's `Now` tab. This is the same order, so the modal, the
 * operator page and `pnpm report` all read alike.
 *
 * Any field NOT listed here still renders — `orderedFields` appends the remainder — so adding one to
 * `SessionSnapshot` and forgetting this array costs it a good position, never its visibility.
 */
const FIELD_ORDER: (keyof SessionSnapshot)[] = [
  "focusedLesson",
  "conversationLesson",
  "conversationId",
  "savedFor",
  "metaTitle",
  "provider",
  "version",
  "status",
  "owns",
  "starting",
  "kickedOff",
  "held",
  "silenced",
  "muted",
  "speaking",
  "heartbeat",
  "holdSnapshot",
  "lines",
  "carried",
  "resumeCause",
  "resumeLines",
  "usage",
  "capabilities",
  "restoreToken",
  "lastError",
];

/** A snapshot's fields, in reading order, with anything unlisted appended rather than dropped. */
export function orderedFields(snapshot: SessionSnapshot): (keyof SessionSnapshot)[] {
  const present = new Set(Object.keys(snapshot) as (keyof SessionSnapshot)[]);
  const known = FIELD_ORDER.filter((k) => present.has(k));
  const rest = [...present].filter((k) => !FIELD_ORDER.includes(k));
  return [...known, ...rest];
}

/** The fields where `live` and the frozen `atError` snapshot disagree. Empty when there is no freeze. */
export function changedFields(
  live: SessionSnapshot | undefined,
  atError: SessionSnapshot | null | undefined,
): (keyof SessionSnapshot)[] {
  if (!live || !atError) return [];
  return orderedFields(live).filter(
    (k) => JSON.stringify(atError[k]) !== JSON.stringify(live[k]),
  );
}
