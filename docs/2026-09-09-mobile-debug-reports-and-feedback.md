# Debug reports from the phone

**Date:** 2026-09-09 · **Status:** research, nothing implemented · **Scope:** `apps/mobile`,
`packages/shared`, `supabase/`, `apps/web` (operator surface only)

A diagnostics modal on the lesson screen, a bounded event log behind it, a `debug_reports` table the
phone writes to, an operator page on the web app that reads them back, and a way to put one in front
of Claude without copy-pasting a screenshot.

---

## §0 What is proposed, in one page

| # | Piece | Where | Why it has to be there |
|---|-------|-------|------------------------|
| 1 | **The diagnostics bus** — a bounded, append-only ring of structured events with a monotonic sequence number | `apps/mobile/src/lib/diagnostics.ts`, module scope | The session outlives every screen; a log in React state would redraw the transcript on every event |
| 2 | **The snapshot** — the session state machine as it stands, *including the refs no render can see* | registered by `TutorSessionProvider` with the bus | The interesting half of `lib/tutor-session.tsx` is refs, not state: `conversationIdRef`, `savedForRef`, `kickedOffRef`, `ownsRef`, `snapshotRef` |
| 3 | **The modal** — `Now` / `Log` / `Send`, opened from the Practice panel and auto-offered on error | `apps/mobile/src/app/lessons/[id]/` | The place where a failed lesson is standing when it fails |
| 4 | **The contract** — `DebugReportInput`, the code registry, `sanitizeDebugReport` | `packages/shared/src/debug/` | Phone and server must agree on the shape, and the server must not trust the phone's bounds |
| 5 | **The table** — `debug_reports`, owner-scoped, RLS, `state` + `events` jsonb | `supabase/migrations/0019_debug_reports.sql` | A report has to survive the app being reinstalled and the session being over |
| 6 | **The route** — `POST /api/v2/debug-reports` under `withBearer`, returns the report id | `apps/web/src/app/api/v2/debug-reports/route.ts` | Same auth path as every other native write |
| 7 | **The spool** — reports queue on the device and retry on foreground | `expo-sqlite/kv-store`, beside the session journal | A report is written exactly when the network is the thing that broke |
| 8 | **The operator page** — list + detail, joined to `lesson_sessions` and LangSmith | `apps/web/src/app/ops/reports/` | Reading 300 events out of a JSON blob in the Supabase console is not analysis |
| 9 | **The handoff to Claude** — `pnpm report <id>` prints one self-contained Markdown document | `apps/web/scripts/report.ts` | The MCP server is deliberately write-only and blind (§13); a repo script needs no new auth surface |

Staged so each stage is useful alone: **S1** bus + snapshot + modal (read-only, no database) →
**S2** table + route + send + spool → **S3** operator page → **S4** handoff script.

---

## §1 The failure this exists for

### 1.1 The outage that was already survived once, and is not survivable twice

`apps/mobile/src/lib/tutor-error.ts` is a whole file of scar tissue from 2026-08-20: the ElevenLabs
account ran dry, the platform answered every `startSession` with an `error_event` carrying no
message, and the app told the learner it might be a microphone permission. The docblock is explicit
about the second failure, and it is the one that matters here:

> **The diagnostics were thrown away.** `onError` is `(message, context?) => void` and the SDK fills
> `context` with `{ errorType, code, debugMessage, details }` straight off the wire […] The screen's
> handler took one parameter, so everything that could have named the cause was dropped on the floor
> while the UI said "Unknown error".

The repair was to fold `context` into the sentence — `tutorErrorMessage` builds a parenthetical
`errorType · code N · debugMessage` and the docblock says why plainly: "this string is what gets
screenshotted and pasted into a bug report".

**A screenshot of one sentence is still the reporting channel.** That is the actual gap. The fix
made the sentence honest; it did not make anything else recoverable. Nothing tells you what the
status transitions were, whether the token mint succeeded, which provider was selected, whether the
app owned the conversation, or what happened in the ninety seconds before.

### 1.2 Nineteen catches that swallow by design

```
$ grep -rn "catch {" apps/mobile/src/lib | wc -l
19
```

Every one of them is correct. `writeJournal`, `readJournal`, `clearJournal`,
`writePauseMarker`, `clearPauseMarker` all swallow because "insurance that breaks the thing it
insures is worse than no insurance". `persistConversation` swallows because "a failed save must not
break the UI". The `after()` LangSmith trace swallows because "an observability write must never be
able to fail a transcript write".

The design is right and it should not change. But the *consequence* is that the app's entire
failure surface is invisible: a device whose SQLite is wedged, a token that expires mid-lesson, a
persist that 404s because the lesson was soft-deleted on another client — all of them produce
exactly the same thing on screen, which is nothing.

**The bus does not change a single one of those catches.** It gives each of them one line to write
before it swallows. That is the whole intervention.

### 1.3 The warnings nobody can see

From `lib/tutor-session.tsx:962`, about the proactive kickoff:

> Keyed on `status` and it must stay that way: `WebRTCConnection.sendMessage` drops anything sent
> before `RoomEvent.Connected` **with a console warning and no error**.

There is no `console.*` anywhere in `apps/mobile/src` (verified: zero matches) and no console
capture. On a TestFlight build that warning goes to a Xcode console nobody is attached to. If the
keying ever regresses, the symptom is "the tutor doesn't say hello sometimes" and the evidence has
already been discarded. The same is true of every warning the LiveKit, Daily and OpenAI stacks emit.

### 1.4 Three providers, three vocabularies, one screen

| | ElevenLabs | OpenAI Realtime | Vapi |
|---|---|---|---|
| Adapter | `transport/elevenlabs.ts` | `transport/openai.ts` | `transport/vapi.ts` |
| Token route | `/api/v2/words-agent/token` | `/api/v2/words-agent/openai-token` | `/api/v2/words-agent/vapi-token` |
| Transport | LiveKit (SDK-owned) | raw WebRTC + SDP POST | Daily, via `daily-webrtc-shim.ts` |
| Error arrives as | `onError(message, context)` with `errorType`/`code`/`debugMessage` | thrown `Error` from the SDP exchange, `HTTP nnn` | `onError(message)` + a shim that may refuse to install at all |
| Turn usage | never (billed per minute; the post-call webhook is richer) | `onUsage` per turn | via webhook |
| Post-call webhook | `/api/words-agent/elevenlabs-webhook` → LangSmith | none — the client write is the only witness | `/api/v2/vapi/webhook` |
| `cancelTurn` | `false` (pause fakes it with a user message) | `true` | see adapter |
| Audio session | SDK owns it globally, no opt-out | `lib/audio-session.ts` | Daily |

Nothing wrong with the asymmetry — the whole point of `@tutor/shared/tutor/transport` is that the
session asks `capabilities` rather than assuming. But it means **"it didn't work" is three different
questions**, and the person asking has no way to tell which one they are in. A report that does not
say which provider, which token route, which SDK version and which capability set was in play is a
report about nothing.

### 1.5 What "send it to Claude" actually has to contain

Working backwards from what an investigation needs:

1. **Which build.** App version, build number, EAS variant, `apiBaseUrl`, OS version, device model.
   Without it every answer starts with "which build were you on".
2. **Which provider, which version, which agent.** Prompt version, provider id, and the agent/
   assistant id the token route returned — the last one being the join key into the ElevenLabs or
   Vapi console.
3. **The row key.** `conversationId`. It joins to `lesson_sessions`, to the LangSmith trace
   (`chain "lesson <conversation_id>"`), and to the provider's own console. **With it, the report
   does not have to carry the transcript at all** — the transcript is already stored server-side
   under that key, for that owner. The report carries the key and the operator page joins.
4. **The sequence.** Not "an error happened" but what the status was before it, whether the mint
   answered, whether ownership was claimed, whether the kickoff fired.
5. **The invisible state.** See §5 — the refs.
6. **What the learner was doing and what they expected.** One free-text field. It is the only thing
   in the report a machine cannot produce, and it is routinely the fastest route to the cause.

---

## §2 What exists today

| Thing | File | Verdict |
|---|---|---|
| A newest-first, bounded (400), timestamped in-memory log with kinds `you`/`agent`/`status`/`appstate`/`error`/`note` | `hooks/use-event-log.ts` | **The right idea, in the wrong place.** React state, and used only by `app/auth.tsx`. Its docblock argues newest-first and wall-clock timestamps; both arguments survive into the bus |
| Error wording with the vendor diagnostics folded in | `lib/tutor-error.ts` | Keep as the learner-facing sentence. The bus wants the *structured* `context` alongside it |
| A single `error: string \| null` on the session state | `lib/tutor-session.tsx:278` | One slot, overwritten by the next error, cleared by the next Start (`:823`, `:1052`) |
| Transcript crash insurance in kv-store | `lib/session-journal.ts` | The precedent the report spool copies verbatim, including "swallow everything" |
| Structured server-side observability | `lib/langsmith-trace.ts`, both webhooks | Excellent — **and blind to the client.** A lesson that never connected produces no trace, because there was no conversation |
| Pure-logic checks without a test runner | `packages/shared/check.ts`, `apps/mobile/check.ts` | Where the sanitizer and the redactor get checked |
| Owner-scoped native writes | `lib/auth/bearer.ts` + `withBearer` | The report route's auth, unchanged |
| A modal component vocabulary | `ui/ConfirmDialog.tsx`, `ui/PromptDialog.tsx`, `ui/Select.tsx` | RN `Modal` is already the app's idiom; the debug modal is a fourth user, not a new pattern |
| An MCP server | `app/api/mcp/route.ts` | Deliberately write-only and blind. §13 respects that line rather than crossing it |

**Nothing to delete.** Everything proposed here is additive, and the one existing piece it supersedes
(`use-event-log`) can stay where it is until the auth probe screen is retired.

---

## §3 The four pieces, and the seam between them

```
 ┌─ apps/mobile ──────────────────────────────────────────────────────────────┐
 │                                                                            │
 │  transports ──┐                                                            │
 │  session ─────┼──▶  diagnostics bus  ──▶  DebugReportInput  ──▶ apiFetch ──┼──▶ POST /api/v2/debug-reports
 │  apiFetch ────┤     (module singleton,     (built on Send,      (or spool) │        │
 │  AppState ────┤      ring of 300)           from snapshot                  │        ▼
 │  console ─────┘            │                + ring + note)                 │   sanitizeDebugReport
 │                            │                                               │        │
 │                     snapshot fn ◀── registered by TutorSessionProvider      │        ▼
 │                            │                                               │   debug_reports
 │                            ▼                                               │        │
 │                    the Debug modal (Now / Log / Send)                      │        ▼
 └────────────────────────────────────────────────────────────────────────────┘   /ops/reports
                                                                                        │
                                                                                        ▼
                                                                                 pnpm report <id>  ──▶ Claude
```

The seam that matters: **the bus is a mobile module and the report is a shared contract.** The
transport adapters are all mobile files (`apps/mobile/src/lib/transport/*.ts`), so they can import
the bus directly — which means `packages/shared/src/tutor/transport.ts` does **not** change, and
neither does `packages/shared/src/testing/fake-transport.ts`. Widening `onError` to carry structured
detail would have been the obvious move and it is the wrong one: it makes three adapters, one fake,
and the session all change for something only the phone consumes.

Applying the shared-package test from `CLAUDE.md` — *if this had a bug, could I fix it by deploying
the web app alone?* — sorts the rest:

- `DebugEvent` / `DebugReportInput` / the code registry / `sanitizeDebugReport` / the limits: **shared**.
  The server must be able to reject an over-large report from an old build, and the operator page must
  render events an old build wrote.
- The ring buffer, the console patch, the snapshot registration, the spool: **mobile**. A bug in any
  of them is fixed by shipping a build, which is the definition of not-shared.

---

## §4 The diagnostics bus

### 4.1 A module singleton, not React state

Three arguments, all of them already made elsewhere in this codebase:

1. **The session outlives every screen.** `TutorSessionProvider` sits above the router
   (`app/_layout.tsx`) precisely so a lesson survives navigation. A log that lived in a screen would
   have a hole in it exactly where the interesting navigation happened. `lib/lesson-card.ts` already
   holds module-scope state for the same reason ("a Live Activity outlives this screen, this
   navigation stack and this process").
2. **It must not re-render anything.** The session's own docblocks make this argument twice — for
   `usageRef` ("a value that changed on every turn would redraw the transcript for a number the
   learner never sees") and for the third `ActiveContext` ("reading it to render one chip would
   redraw the whole list several times a minute"). A log fed by every SDK callback is strictly worse
   than either.
3. **It has to be writable from outside React.** `apiFetch` is a plain function. The `ErrorUtils`
   global handler is not in a component. The lock-screen intent drain runs from a native event.

The modal subscribes with `useSyncExternalStore` **only while it is open**, and the store's
`getSnapshot` returns a frozen array identity that changes only when the ring changes.

```ts
// apps/mobile/src/lib/diagnostics.ts  (sketch)
let ring: DebugEvent[] = [];
let seq = 0;
let sessionStartedAt = Date.now();
const listeners = new Set<() => void>();

export function emit(e: Omit<DebugEvent, "seq" | "at" | "since">): void { … }
export function subscribe(fn: () => void): () => void { … }
export function readEvents(): readonly DebugEvent[] { return ring; }
export function markSessionStart(): void { seq = 0; sessionStartedAt = Date.now(); }
```

`seq` is monotonic **across the process, never reset per event batch**: a report whose sequence
numbers jump is a report that dropped events, and that is worth being able to see. `markSessionStart`
resets the *relative clock*, not the ring — the events from before a Start are frequently the
explanation for the Start failing.

### 4.2 The event shape

```ts
// packages/shared/src/debug/report.ts
export interface DebugEvent {
  /** Monotonic within the process. A gap means the ring dropped, and that is information. */
  seq: number;
  /** Absolute ISO-8601. Absolute rather than relative, for the same reason `use-event-log` is:
   *  the only way to line an event up against a server log or against the moment you locked the phone. */
  at: string;
  /** ms since the last `markSessionStart`. Negative before a session starts, deliberately. */
  since: number;
  level: "debug" | "info" | "warn" | "error";
  /** A slug from the registry in ./codes.ts. The groupable half. */
  code: DebugCode;
  /** One sentence for a human. Never the only carrier of a fact `data` should hold. */
  message: string;
  /** Which stack this came from, `null` for app-level events. */
  provider: TutorProviderId | null;
  /** Redacted structured detail. Bounded — see §8. */
  data?: Record<string, string | number | boolean | null>;
}
```

`data` is deliberately **flat and scalar-valued**. Not because nesting is hard, but because a
free-form `unknown` becomes the place someone drops a whole SDK object, and then the report is 4 MB
and half of it is a token. Flat scalars make the redactor's job decidable (§6) and make the operator
page's rendering trivially uniform.

### 4.3 The code registry

A closed set in `packages/shared/src/debug/codes.ts`, because it is the axis every later question is
grouped by: *how many reports this week have `elevenlabs.error` with `code 1008`?*

```ts
export const DEBUG_CODES = [
  // lifecycle
  "app.foreground", "app.background", "app.launch", "app.crash", "app.unhandled_rejection",
  // session machine
  "session.focus", "session.start", "session.start_refused", "session.claim", "session.release",
  "session.kickoff", "session.end", "session.status", "session.error", "session.id_mismatch",
  // pause
  "pause.hold", "pause.hold_plan", "pause.release", "pause.release_plan", "pause.heartbeat_failed",
  // durability
  "journal.write", "journal.write_failed", "journal.restore", "journal.clear_failed",
  "pausemarker.write", "pausemarker.restore",
  "persist.ok", "persist.failed", "persist.skipped",
  // transport (provider on the event says which)
  "transport.mint", "transport.mint_failed", "transport.connect", "transport.connected",
  "transport.disconnect", "transport.error", "transport.usage", "transport.shim",
  // network
  "api.request", "api.failed", "api.retry_401",
  // captured console
  "console.warn", "console.error",
] as const;
export type DebugCode = (typeof DEBUG_CODES)[number];
```

Two properties worth stating: the union is **open at the edges of the server** (the route stores an
unknown code rather than rejecting the report — an old phone must still be able to file) but
**closed on the phone** (a typo is a compile error). And `session.start_refused` exists because
`focusLesson`'s refusal *is the feature* — a refusal that leaves no trace is indistinguishable from a
button that did nothing.

### 4.4 What each source emits

**The session** (`lib/tutor-session.tsx`) — the highest-value instrumentation in the app, because it
is where the state machine is:

| Site | Emit |
|---|---|
| `focusLesson` early return on live session | `session.start_refused` with `{ focused, live, status }` |
| `start` takeover branch | `session.start` with `{ lessonId, version, provider, takeover: true }` |
| `onIdentified` seam | `session.claim` with `{ conversationId, version }` |
| `claimSession(false)` on a failed start | `session.release` with `{ reason: "start_threw" }` |
| `onTransportId` mismatch (`:431`) | `session.id_mismatch` — today it only sets a string on screen |
| kickoff effect | `session.kickoff` with `{ resumed: boolean, cause }` |
| `onEnd` | `session.end` with `{ reason, lines, stillFocused }` |
| `hold`/`release` | `pause.hold_plan` with the **plan object** from `planHold`, `{ silenced }` from `applyHold` |
| `persistConversation` catch | `persist.failed` with `{ status, code }` from `ApiFetchError` |
| `journal()` / `writeJournal` catch | `journal.write_failed` |

`pause.hold_plan` deserves a note. `planHold`/`planRelease` are pure and property-checked in
`pnpm check:shared`, and the docblock says why: "this branch used to be reachable only on a phone,
in a billed session, and getting it wrong shows up as the tutor saying a plausible wrong thing."
Logging the plan closes that loop from the other end — when the tutor *does* say a plausible wrong
thing, the report says which branch produced it.

**The transports** — each adapter emits a *preamble* on start and then its own events:

```ts
emit({ level: "info", code: "transport.mint", provider: "elevenlabs", message: "minting token",
       data: { route: conversationTokenPath(version), version } });
```

The preamble should carry, per provider: SDK package version (from `package.json` at build time),
`capabilities` (all four flags — they differ per provider and drive the pause branch), the agent /
assistant id the mint returned, and for Vapi the `describeShim(shim)` string from
`daily-webrtc-shim.ts:138`, which today is only ever seen inside a thrown `Error` message.

For ElevenLabs specifically: `onError(message, context)` should emit `transport.error` with the
**structured** `errorType` / `code` / `debugMessage` in `data`, *in addition to* passing the composed
sentence to the session. That is the direct repair of the "dropped on the floor" failure in §1.1 —
this time the fields land somewhere a query can reach them.

**`apiFetch`** (`apps/mobile/src/api.ts`) — one emit per request with `{ path, method, status, ms }`,
one for the 401 retry (`api.retry_401`), one for a throw. **Never headers, never bodies.** The path
is safe and is the interesting part; the token routes' *bodies* are the least safe thing in the app.

**AppState** — `app.foreground` / `app.background`. Cheap, and the single most common question about
a locked-screen bug is what the app state timeline looked like.

### 4.5 Console capture

`console.warn` and `console.error` patched into the bus at module load, wrapping the originals rather
than replacing them (RN's LogBox stays intact). Bounded to the first 200 chars of the joined args and
rate-limited — a chatty SDK in a loop must not evict the whole ring.

This is what makes the §1.3 class of failure visible: LiveKit's dropped-message warning, Daily's shim
complaints, React key warnings, and every SDK deprecation notice. It costs about twenty lines and it
is the highest ratio of evidence-per-line in the whole proposal.

**Do not capture `console.log`.** Different signal-to-noise entirely, and the ring is 300 entries.

### 4.6 Bounds

| Bound | Value | Why |
|---|---|---|
| `MAX_DEBUG_EVENTS` | 300 | `use-event-log` chose 400 for "a 3-minute test with room to spare". This ring carries denser events; 300 at ~200 bytes each is ~60 KB serialized |
| `MAX_DEBUG_MESSAGE` | 400 chars | Mirrors `MAX_TRANSCRIPT_LINE_CHARS`'s reasoning |
| `MAX_DEBUG_DATA_KEYS` | 12 | A flat scalar map that needs more than twelve keys is an object someone dumped |
| `MAX_DEBUG_DATA_VALUE` | 200 chars | Long enough for a URL path, short enough that a token cannot hide in it |
| `MAX_REPORT_BYTES` | 256 KB | Checked after serialization, on **both** sides |

Eviction is oldest-first, **except** that events at `level: "error"` are never evicted while any
`debug`-level event remains. A ring flooded by `transport.usage` that dropped the connect failure is
a ring that was not worth keeping.

---

## §5 The state snapshot

### 5.1 The invisible half

`TutorSessionState` — the fourteen fields a screen renders — is the *easy* half, and it is not where
the bugs are. The bugs are in the refs, because the refs are what the callbacks read:

| Ref | In `TutorSessionState`? | What its wrong value looks like |
|---|---|---|
| `conversationIdRef` | no | A transcript filed under the wrong conversation, or none |
| `convLessonRef` | no | A transcript filed under whichever lesson was opened next — "not recoverable", per its docblock |
| `savedForRef` | no | A save that silently no-ops, or one that double-writes |
| `ownsRef` / `owns` | as `owns`, indirectly | Turns pushed into someone else's transcript; a second kickoff |
| `startingRef` | as `busy`, lossily | The takeover half-beat: an End button belonging to a lesson being replaced |
| `kickedOffRef` | no | The tutor never opens its mouth, or opens it twice |
| `usageRef` | no | Token totals filed against the wrong conversation |
| `snapshotRef` | as `held`, lossily | The pause resumes with the wrong one of three plans |
| `resumeContextRef` | as `carried`, lossily | The tutor is handed a truncated tail and continues the wrong conversation |
| `providerRef` | as `version`, indirectly | The idle transport's events land in the live session's state |
| `restoreTokenRef` | no | One lesson's parked pause shown on another lesson's screen |
| `heartbeatRef` | no | A held pause that the turn timer kills anyway |
| `metaRef` | no | A lock-screen card describing a different lesson |

Every one of those failure modes is documented in `lib/tutor-session.tsx` as a hazard that was
specifically designed against. **None of them is observable from the outside.** A snapshot that
carries the refs turns "the pause didn't resume properly" from a conversation into a lookup.

### 5.2 `registerSnapshot`

The provider registers a *function* with the bus, once, at mount:

```ts
// inside TutorSessionProvider
useEffect(() => registerSnapshot((): SessionSnapshot => ({
  focusedLesson: lessonIdRef.current,
  conversationLesson: convLessonRef.current,
  conversationId: conversationIdRef.current,
  savedFor: savedForRef.current,
  owns: ownsRef.current,
  starting: startingRef.current,
  kickedOff: kickedOffRef.current,
  status: statusRef.current,
  provider: providerRef.current,
  version: versionRef.current,
  held: heldRef.current,
  muted: mutedRef.current,
  speaking: speakingRef.current,
  lines: linesRef.current.length,          // count, not content
  carried: carriedCount,
  usage: usageRef.current,
  holdSnapshot: snapshotRef.current,
  resumeCause: resumeContextRef.current?.cause ?? null,
  resumeLines: resumeContextRef.current?.lines.length ?? 0,
  heartbeat: heartbeatRef.current !== null,
  capabilities: tx.capabilities,
}), []);
```

A function, not a value, so **nothing re-renders and nothing is copied until the modal is opened**.
No dependency array churn, no state, no cost when the modal is closed — which is always.

`lines` is a **count**, not the lines. See §6.

### 5.3 The error freeze

A learner hits an error at 14:02 and opens the modal at 14:07. By then `start` has been pressed
again, `setError(null)` has run (`:823`), the refs describe a different conversation, and the live
snapshot describes a healthy session that is not the one being reported.

So: **on the first `level: "error"` event after a clean period, the bus freezes a copy of the
snapshot** and keeps it alongside the live one. The report carries both, labelled. This is the same
argument the session already makes about `resumeContextRef` — a value that can drift out of sync with
its lines eventually describes the wrong conversation.

---

## §6 Redaction, and what never reaches the bus

**Never logged, at any level:**

- Auth0 access tokens and refresh tokens, and the `authorization` header in any form
- The response bodies of the three token routes — ElevenLabs conversation tokens, OpenAI ephemeral
  keys, Vapi public keys, LiveKit URLs (which carry a token in the query string)
- Any SDP payload
- The Auth0 `sub` inside `data` (it is already the row's `owner_id`; a second copy inside a free-text
  blob is a copy that outlives a deletion)

**Structurally excluded rather than filtered.** The `data` map is flat scalars with a 200-char value
cap, and `apiFetch` emits `{ path, status, ms }` — the token never enters the bus, so there is
nothing to redact. Filtering is the backstop, not the mechanism.

The backstop, in shared, property-checked in `packages/shared/check.ts`:

```ts
export function redactValue(key: string, value: string): string;
// - drops any key matching /token|secret|key|authorization|password|bearer|jwt/i
// - replaces any value matching a JWT shape (three base64url segments) with "<jwt>"
// - replaces any value with a `?...token=` query fragment with its path
```

**Transcript text.** The default is **not to include it**, and the reason is not squeamishness — it
is that including it is *redundant*: the transcript for `conversationId` is already in
`lesson_sessions` for the same `owner_id`, and the operator page joins on it (§12.3). The only case
with no server-side copy is a session that never connected, which by definition has no transcript.
The modal offers an explicit "include the last 10 lines" toggle, default **off**, for the one case it
helps: a report about *what the tutor said*, filed while the conversation is still live and unsaved.

---

## §7 The modal

### 7.1 Entry points

Two, and the second one is the one that will actually get used:

1. **Quiet and permanent** — a `Diagnostics` link in the Practice panel footer, in `Muted` type. The
   learner and the developer are currently the same person; this does not need a build flag. If that
   changes, gate it on `__DEV__ || variant !== "production"` and keep the second entry point for
   everyone.
2. **Offered at the moment of failure** — the existing error `Panel` (`tone="error"`) gains a
   `Report this` button beside `Try again`. Reports filed here arrive pre-filled: the frozen
   snapshot, the error event, the code, and a note field already focused.

Entry point 2 is why this gets used at all. Asking someone to reproduce a failure in order to report
it is asking them not to report it.

### 7.2 Three tabs

**Now.** The snapshot, rendered as labelled rows, in the order an investigation reads them:

```
BUILD      1.0.0 (42) · preview · iOS 26.1 · iPhone 15 Pro
API        https://…vercel.app        network: online
LESSON     focused 3f2a… · conversation 3f2a…            ← differing values are the bug
PROVIDER   elevenlabs · words-3.0 · agent_01jz…
SESSION    status connected · owns ✓ · starting ✗ · kickedOff ✓
PAUSE      held ✓ · silenced ✓ · heartbeat ✓ · plan barge-in:user-message
TRANSCRIPT 24 lines · carried 6 · saved-for 3f2a… (matches ✓)
USAGE      in 1.2k · out 800 · audio-in 4.1k · audio-out 9.3k
CAPS       silenceOutput ✓ · userActivity ✓ · cancelTurn ✗ · responseCorrection ✓
LAST ERROR Server error: Unknown error (quota_exceeded · code 1008)
```

Differing values are the point: `focused ≠ conversation`, `conversationId ≠ savedFor`,
`owns ✗ while status connected` are each one glance away from being obvious, and each is a documented
hazard in `tutor-session.tsx`. Render the mismatching ones in the error tone.

**Log.** The ring, **newest first** — inheriting `use-event-log`'s argument verbatim: after a lock or
a failure you want what just happened at the top, not three minutes of scrolling away. A level filter
(`all` / `warn+` / `error`), and a tap to expand `data`. Wall-clock on the left, `+1.4s` relative on
the right.

**Send.** A `TextField` for "what happened / what you expected", the transcript toggle (§6), a size
readout ("48 KB, 216 events"), and the button. On success it shows the report id in a copyable short
form and — the useful part — the exact string to paste to Claude: `report 4f2a1c9e`.

### 7.3 What a modal is not

It is not a place to *fix* anything. No "force disconnect", no "clear journal", no "re-mint token".
Every one of those is a foot-gun that will eventually be pressed during a live billed lesson, and
each duplicates a control that already exists with different semantics. Read-only, plus Send.

### 7.4 Copy / share, and one new dependency

`expo-clipboard` is not currently a dependency. Two options: add it (~1 line in `package.json`, no
config plugin, no prebuild change) for a "Copy JSON" button; or use RN's built-in `Share` API, which
needs nothing and hands the report to Mail/Messages/Files. **Recommend `Share`** for S1 and defer the
clipboard dependency until the send path proves it needs one. Copy is the offline escape hatch, and
Share is a better offline escape hatch than a clipboard.

---

## §8 The wire contract

```ts
// packages/shared/src/debug/report.ts
export interface DebugReportInput {
  /** What kind of report this is. The operator page's first filter. */
  kind: "error" | "feedback" | "manual";
  /** What the learner typed. The one field a machine cannot produce. */
  note: string;
  /** Join keys. Any of them may be null — a report about a lesson that would not start has no conversation. */
  lessonId: string | null;
  conversationId: string | null;
  provider: TutorProviderId | null;
  agentVersion: string | null;
  /** Denormalized for list rendering and grouping; also present inside `events`. */
  errorCode: string | null;
  errorMessage: string | null;
  /** Build identity. */
  client: {
    appVersion: string; buildNumber: string; variant: string;
    platform: "ios"; osVersion: string; deviceModel: string;
    apiBaseUrl: string; online: boolean;
  };
  /** Live snapshot, plus the frozen one from §5.3 when there is one. */
  state: { live: SessionSnapshot; atError: SessionSnapshot | null };
  events: DebugEvent[];
  /** Opt-in tail, empty by default (§6). */
  transcriptTail: TranscriptLine[];
  /** Set by the phone when the report was spooled offline, so the row's created_at is not a lie. */
  capturedAt: string;
}

export function sanitizeDebugReport(body: unknown): DebugReportInput | null;
```

`sanitizeDebugReport` follows `sanitizeTranscript` exactly — same file style, same posture, same
place in the architecture:

- runs on the **server**, in the route, on a body from a client that is never trusted;
- **also** runs on the phone before spooling, so an over-large report is trimmed before it is stored
  on the device rather than after it fails to upload;
- truncates rather than rejects wherever truncation is meaningful (events, message lengths,
  transcript tail), because a trimmed report is worth infinitely more than a 413;
- rejects only what is structurally unusable (no `kind`, not an object);
- **preserves unknown `code` values.** An old build filing a code this server does not know must
  still get a row. This is the one place the closed union is deliberately opened.

Checked in `packages/shared/check.ts`, in the style already there: an oversized report trims to
exactly `MAX_DEBUG_EVENTS`; a jwt-shaped value is redacted; an unknown code survives; a report with a
1 MB note comes back under `MAX_REPORT_BYTES`; error-level events survive eviction of debug-level
ones.

---

## §9 The table

`supabase/migrations/0019_debug_reports.sql`:

```sql
-- 0019_debug_reports.sql — diagnostic reports filed from the phone.
--
-- One row per report. Written only by /api/v2/debug-reports (Bearer, owner-scoped); read by the
-- operator page and by scripts/report.ts. Never written by a job, never by the webhooks.
--
-- The join keys are TEXT AND NOT FOREIGN KEYS on purpose, except lesson_id:
--   * conversation_id may name a conversation that has no lesson_sessions row — a session that
--     failed to connect is exactly the case this table exists for, and a FK would reject it.
--   * lesson_id IS a FK, but ON DELETE SET NULL: lessons are soft-deleted (0008) and a hard delete
--     must not take the evidence with it.

create table debug_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,                        -- Auth0 sub, from the verified Bearer token
  created_at timestamptz not null default now(), -- when the SERVER received it
  captured_at timestamptz not null,              -- when the PHONE built it (differs when spooled)

  kind text not null check (kind in ('error','feedback','manual')),
  note text not null default '',

  lesson_id uuid references lessons(id) on delete set null,
  conversation_id text,                          -- joins lesson_sessions.conversation_id, no FK
  provider text,                                 -- 'elevenlabs' | 'openai' | 'vapi', unconstrained
  agent_version text,

  error_code text,                               -- denormalized from events, for grouping
  error_message text,

  client jsonb not null default '{}'::jsonb,     -- build identity
  state jsonb not null default '{}'::jsonb,      -- { live, atError }
  events jsonb not null default '[]'::jsonb,     -- the ring
  transcript_tail jsonb not null default '[]'::jsonb,

  -- triage, owned by the operator page. Not an enum: adding a state must not need a migration.
  status text not null default 'new',
  resolution text
);

create index debug_reports_owner_created_idx on debug_reports (owner_id, created_at desc);
create index debug_reports_created_idx       on debug_reports (created_at desc);
create index debug_reports_error_code_idx    on debug_reports (error_code, created_at desc)
  where error_code is not null;
create index debug_reports_conversation_idx  on debug_reports (conversation_id)
  where conversation_id is not null;

alter table debug_reports enable row level security;

create policy "debug_reports owner select" on debug_reports for select
  using (owner_id = auth.jwt() ->> 'sub');
create policy "debug_reports owner insert" on debug_reports for insert
  with check (owner_id = auth.jwt() ->> 'sub');
```

Notes on the choices:

- **`provider` is unconstrained text, not a check constraint.** A fourth provider must not need a
  migration before its first failure can be reported. Same reasoning as `status`.
- **`captured_at` separate from `created_at`.** A spooled report can arrive hours after the failure.
  Collapsing them makes every offline report lie about when the bug happened — and offline reports
  are disproportionately the interesting ones.
- **`error_code` denormalized.** It is inside `events` too. It is lifted out because the first
  question the operator page asks is "group by error", and a `jsonb` scan per row for a list view is
  a page that gets slow at exactly the moment it starts being useful.
- **No `updated_at`.** A report is an observation; the only mutable fields are the triage pair, and
  their history is not interesting enough to pay for a trigger.
- **RLS insert policy included for symmetry** with `lessons`/`lesson_sessions`, though as everywhere
  else in this repo the write goes through the service-role client and ownership is enforced in code
  (`CLAUDE.md`: "Ownership is enforced in code […] RLS is defense-in-depth").

---

## §10 The route

`POST /api/v2/debug-reports`, `withBearer`, `dynamic = "force-dynamic"`, `OPTIONS = preflight` — the
same four lines every v2 write route opens with. Add to `API_V2_ROUTES` in
`packages/shared/src/api.ts`:

```ts
debugReports: `${API_V2}/debug-reports`,
```

```ts
export const POST = withBearer(async (req, ownerId) => {
  const input = sanitizeDebugReport(await req.json().catch(() => null));
  if (!input) return apiError(400, "bad_request", "Malformed debug report.");

  // The lesson is checked against the owner exactly as persistTutorSessionFor does — but a report
  // about an UNKNOWN lesson is still stored, with lesson_id nulled. Refusing it would discard the
  // report whose lesson id is wrong, which is a report about a bug in how lesson ids are handled.
  const lesson = input.lessonId ? await getLesson(ownerId, input.lessonId) : null;

  const id = await insertDebugReport(ownerId, { ...input, lessonId: lesson?.id ?? null });
  return json({ id } satisfies DebugReportResponse);
});
```

Three deliberate choices:

1. **It returns the id.** The modal shows it; the learner quotes it; `pnpm report <id>` resolves it.
   Without it the only handle on a report is a timestamp.
2. **An unknown lesson does not 404.** Unlike `/api/v2/lessons/session`, which correctly 404s because
   a transcript for a non-existent lesson is meaningless. A *report* whose lesson id is wrong is
   evidence about the wrong lesson id.
3. **No `after()` work, no LangSmith trace, no revalidate.** A report is not an event in the
   learner's history; it is an artifact about one. The one thing worth considering later is a
   notification (§16 Q4).

Rate limiting: a per-owner cap of, say, 20 reports/hour enforced with a `count` on
`(owner_id, created_at > now() - interval '1 hour')` before insert. The route is authenticated, so
this is about a retry loop in the spool, not about abuse — which means the cap should **drop the
report and return 200**, not error, or the spool will retry forever.

---

## §11 Delivery when the network is the bug

### 11.1 The spool

A report is generated at the exact moment things are broken, and "broken" is often "the request that
would file this report will also fail". So the send path is:

```
build report → sanitize → try POST
  ok      → show the id
  failed  → append to the spool (kv-store, bounded to 10, oldest dropped)
            → show "saved on this device, will send when you're back online"
```

Retried on `AppState → active` and on app launch, one at a time, oldest first, stopping on the first
failure. `expo-sqlite/kv-store`, beside the session journal, and swallowing its errors for exactly
the reason the journal does — a spool that breaks the app it is reporting on is worse than no spool.

**Why not the offline outbox?** `packages/shared/src/offline/ops.ts` is a closed union validated
server-side by `parseOutboxRecords`, and its docblock is explicit that the design goal is "queue the
ops in SQLite instead of posting them immediately, and this handler never learns the difference".
A 60 KB diagnostic blob is not a lesson mutation: it does not need ordering against other ops, does
not need the applied/retry semantics, and would make every flush batch fat. A separate 40-line spool
keeps the op algebra clean. (If the outbox ever grows blob support for another reason, revisit.)

### 11.2 Crash capture

The failure with the worst evidence-to-frequency ratio is a fatal JS error: the app disappears and
the ring goes with it. Two handlers, installed once at module load:

```ts
// apps/mobile/src/lib/diagnostics-crash.ts
const previous = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  emit({ level: "error", code: "app.crash", message: String(error?.message ?? error),
         data: { fatal: Boolean(isFatal), stack: String(error?.stack ?? "").slice(0, 200) } });
  void spoolCrashReport();       // best effort; the process may not survive the await
  previous(error, isFatal);      // never swallow — LogBox and the crash reporter still need it
});
```

Plus `unhandledrejection` where RN supports it. The crash report is *spooled, never sent inline* —
there is no time — and picked up on next launch, which is the same shape as the journal's recovery
flow and needs no new UX: the next launch simply has a report waiting to send.

This is the piece that makes a TestFlight crash actionable instead of a "it closed itself".

---

## §12 The operator page

### 12.1 The deprecation tension, resolved

`CLAUDE.md` is unambiguous: *"Do not build new screens there."* This proposal adds screens there.
The resolution is that the sentence is about the **product**, and these are not product:

> `apps/web` is deprecated **as a learner-facing UI** and kept as the backend. Operator surfaces —
> pages that exist to inspect data the backend owns — belong to the backend, not to the deprecated
> client.

Concretely, keep the distinction visible in the filesystem and the routing rather than in a comment:

- route group `apps/web/src/app/ops/` — nothing under it is linked from the learner nav in
  `layout.tsx`;
- the header link is added only when `process.env.OPS_UI === "1"`, or simply never (the URL is typed);
- and `CLAUDE.md` gains one line saying so, otherwise the next person reads the page as a violation
  and either deletes it or, worse, adds a learner page beside it.

**Settled 2026-09-09: the operator page is built, and `CLAUDE.md` gains the qualifying line.**
The fallback that was on the table — §13's script alone, with `CLAUDE.md` left absolute — was
declined. The script is still built (§13, S4): the operator page is the convenience, the script is
the capability, and both are in scope.

### 12.2 List and detail

`/ops/reports` — a server component, `force-dynamic`, cookie auth via `getOwnerId()` (this one is a
browser page, so it is the cookie path, not Bearer):

```
STATUS  WHEN         KIND   PROVIDER/VER      ERROR                    LESSON
new     2h ago       error  elevenlabs/w-3.0  transport.error 1008     Phrasal verbs
new     2h ago       error  elevenlabs/w-3.0  transport.error 1008     Irregular past
open    yesterday    manual openai/w-3.0      —                        Small talk
done    3 days ago   error  vapi/w-3.0        transport.shim           Food
```

Filters: kind, provider, `error_code`, status, date range. Sort by `created_at desc`. The two
identical rows at the top are the point of `error_code` being a column — repetition is the signal
that separates "a thing that happened" from "a thing that is happening".

`/ops/reports/[id]` — the detail:

- **Header:** the join keys, each one a link (§12.3).
- **State:** `live` and `atError` side by side, with **differing fields highlighted**. That diff is
  frequently the entire investigation.
- **Timeline:** the events, **oldest first here** (opposite to the phone — you are reading a story,
  not checking what just happened), with relative `+1.4s` gutters, level colouring, and expandable
  `data`. Sequence gaps rendered explicitly as `— 12 events dropped —`.
- **The note**, quoted at the top where it cannot be missed.
- **Transcript**, from the joined `lesson_sessions` row rather than the report.
- **Triage:** two controls, `status` and `resolution`, as a small server action.

### 12.3 The joins that make it worth opening

| From | To | How |
|---|---|---|
| `conversation_id` | `lesson_sessions` | Direct: the transcript, summary and `duration_secs` the webhook filed |
| `conversation_id` | LangSmith | The trace is named `lesson <conversation_id>` (`lib/langsmith-trace.ts`); a project-search URL is a deterministic string |
| `conversation_id` | ElevenLabs console | Their conversation detail URL takes the id directly |
| `agent_version` | `agents.lock.json` | Via `lib/agent-registry.ts` — resolve to the agent id and the provider, so the page can say *which agent object* was running, not just which version string |
| `lesson_id` | `/lessons/[id]` | Existing page |

The LangSmith link is the one that pays for the page: it turns "the tutor said something wrong" into
the actual model turn, with its usage and tool calls, in two clicks.

---

## §13 Getting a report to Claude

Three options, and the recommendation is the boring one.

**(a) Paste the JSON.** Works today with zero code, and is what happens now, badly. A 60 KB blob
pasted into a chat is most of a context window and unreadable. Not a plan, but the modal's Share
button makes it a fallback that exists.

**(b) A tool on the existing MCP server.** Tempting — `/api/mcp` is already deployed, already
authenticated, already registered with ElevenLabs and OpenAI. **Do not do it.** The route's own
docblock draws this line, and it is right:

> **The first read tool makes this an exfiltration channel.** […] any of them lets the learner's
> collection leave the account and enter a model context someone else may be steering. That is a
> different review, not a bigger version of this one.
>
> **Under one shared secret, a new permission is a new TOKEN — or it does not exist.** […] a read
> tool added here is reachable by every client already holding `MCP_TOKEN`, retroactively.

A debug report is *strictly worse* to expose than the word collection: it contains device identity,
a state machine dump, API paths, and optionally transcript text. Adding `get_debug_report` to
`tutor-collection` would retroactively grant every existing `MCP_TOKEN` holder — including two
third-party voice platforms — read access to it. If the MCP path is wanted later it must be a
**separate server route with a separate secret and its own owner resolution**, which the docblock
already names as "a design decision, not an `if`".

**(c) A repo script — recommended.** `apps/web/scripts/report.ts`, wired as `pnpm report <id>`,
alongside `level:items` and `enrich:words`:

```
$ pnpm report 4f2a1c9e
```

It reads Supabase with the service-role key already in `.env.local`, joins `lesson_sessions` and
resolves `agent_version` through `lib/agent-registry.ts`, and prints **one self-contained Markdown
document**: header, note, state diff, timeline as a table, transcript, and the LangSmith link. No new
auth surface, no new network exposure, no new secret, and Claude Code can run it directly in this
repo. `pnpm report --list` prints the ten newest so an id is never needed from memory.

The output is written **for a model to read**: stable section headers, the timeline as a table with
one event per row, relative timestamps, and the state diff pre-computed rather than left as two JSON
blobs to be compared by eye.

Optional and cheap: `pnpm report <id> --json` for the raw row, and `--since 7d` to print a summary of
recent reports grouped by `error_code` — which is a weekly "what is actually breaking" report for
free.

---

## §14 Volume, cost, retention

Single-learner app, so the numbers are small and should be kept small deliberately.

- A report is ~40–80 KB (300 events at ~200 bytes, plus the snapshots). Supabase free-tier storage is
  8 GB; even at a hundred reports a month this is under 100 MB a year.
- The transcript is **not duplicated** (§6), which is what keeps the row small — a long lesson
  transcript alone can exceed the whole rest of the report.
- Retention: nothing automatic at this volume. If it becomes worth it, a `where created_at < now() -
  interval '180 days' and status = 'done'` delete in a migration or a script beats a cron.
- The one real risk is a **retry loop**: a spooled report that fails to send, is retried on every
  foreground, and eventually succeeds a hundred times because the failure was on the response rather
  than the write. Mitigation: the spool deletes on any 2xx **and on any 4xx** (a report the server
  refuses will never be accepted), and retries only on 5xx and network errors.

---

## §15 Staged plan

**S1 — see it (no database). BUILT 2026-09-09.** `packages/shared/src/debug/{report,codes}.ts` with
the types, limits, `sanitizeDebugReport` and `redactValue`, plus checks in `packages/shared/check.ts`.
`apps/mobile/src/lib/diagnostics.ts` (ring, subscribe, snapshot registry, freeze), console capture,
crash handler, and the instrumentation call sites in the session, the three adapters and `apiFetch`.
The modal with `Now` and `Log`, and Share as the only outbound path.
*Gate:* force a quota-style failure with a bad token; the modal shows the mint failure, the status
transitions, the structured `errorType`/`code`, and the ownership flags — without a debugger attached.

Five things landed differently from the sketch above, each for a reason worth keeping:

- **`trimDebugEvents` is in `packages/shared`, not in the ring.** §17 says shared holds the shape and
  not the mechanism, and that still holds — but the *eviction rule* (an error is never dropped while
  a `debug` event remains) is a BOUND, and the server applies the identical one to a report that
  arrives over-length. One function, so a trimmed report looks the same whichever side trimmed it,
  and the rule is checkable in `check.ts` where the rest of the bounds are.
- **`DebugEvent.code` is typed `string`, not `DebugCode`.** The closed union is enforced where §4.3
  says it must be — on `emit`, where a typo is a compile error — and the wire shape is open, which is
  what lets an old build's unknown code survive `sanitizeDebugReport`. Typing the field itself
  closed would have made the "open at the edges of the server" property a cast.
- **`registerSnapshot` is re-registered every render, not on `[]`.** The §5.2 sketch reads
  `tx.capabilities` and `carriedCount`, which are not refs, and routing them through a mutable ref
  (this file's `latest` pattern) is rejected by the React Compiler's `react-hooks/immutability` rule
  the moment that ref is read from inside a hook argument. The property §5.2 actually wanted — no
  re-render, nothing copied while the modal is closed — is a property of the BODY not running, and
  it is intact: re-registering costs one closure and one `Set` write per render.
- **Session-level events carry `provider: null`.** `providerRef` is written by `start`, so reading it
  from a session callback is the same compile error. It is no loss: the snapshot already says which
  provider is running, and `DebugEvent.provider` means "which stack raised this", which for a session
  event is none.
- **The modal lives at `apps/mobile/src/lib/diagnostics-modal.tsx`,** not under `app/lessons/[id]/`
  as §3 has it. Every file under `src/app/` is a route; a component dropped beside `index.tsx` would
  be reachable at `/lessons/[id]/DiagnosticsModal`.

Also added, because the report cannot answer "which build" without it: `extra.variant` in
`apps/mobile/app.config.ts`, derived from `APP_VARIANT` rather than added to `MobileEnv` (that type
is for values the app must be *configured* with).

*Not yet done, and deliberately:* the `Send` tab, the spool, and crash-report persistence across a
restart are S2 — the crash handler exists and writes its event, but in S1 the ring dies with the
process. `client.online` is hard-coded `true` for the same reason: there is no connectivity module
in this build, and adding one for a boolean nobody reads yet would be a native dependency bought on
credit.

**S2 — send it. BUILT 2026-09-09.** Migration `0019`, the route, `API_V2_ROUTES.debugReports`, the
`Send` tab, the spool, and the crash-report pickup on launch.
*Gate:* airplane mode → file a report → it spools → back online → it lands, `captured_at` is the
failure time and `created_at` is the arrival time.

Four things landed differently from §10 / §11:

- **The rate limit answers `200 {stored: false}`, not a 429**, and `DebugReportResponse` carries a
  `stored` flag for it. §10 already says the cap must "drop the report and return 200"; the flag is
  what lets the phone tell "kept" from "dropped" without inspecting a status code, and it is what
  the modal's outcome line reads.
- **The crash spool is synchronous.** §11.2's sketch calls `void spoolCrashReport()` and notes the
  process may not survive the await — so it uses `expo-sqlite/kv-store`'s `setItemSync`/`getItemSync`
  instead. Only a FATAL error spools; a caught one leaves the app running, and the ring with it.
- **`flushSpool` discards a 4xx and continues, rather than stopping.** §11.1 says "stopping on the
  first failure", and that is right for a closed road (5xx, no network — the next report will meet
  the same wall). A 4xx is an answer about *that one report*, so stopping on it would wedge the whole
  queue behind one permanently unacceptable row.
- **Three codes were added to the registry** — `spool.queued`, `spool.sent`, `spool.dropped`. They
  describe the reporting channel itself, which is the one part of this feature whose failures are
  unobservable by construction: a report that never arrives cannot tell you it never arrived. They
  land in the *next* report, which is the point.

The drain lives in `lib/diagnostics-flush.ts` as a hook, mounted by an empty `DebugSpoolFlush`
component in `app/_layout.tsx` — the capture half installs at module scope because a crash can
precede React, but a *send* needs `useAccessToken()` and cannot. It is keyed on the session being
live, so the crash pickup fires as soon as a token exists rather than racing the silent login.

`0019` was applied on 2026-09-09, together with `0018_unowned_words.sql` — the runner is
forward-only, and `0018` had been committed but never run. Verified after the fact: RLS on with both
policies, four indexes, and `lesson_id` carrying `on delete set null`. The Supabase security
advisors report nothing new (the standing warnings are all pre-existing functions).

**S3 — read it. BUILT 2026-09-09.** `/ops/reports` list and detail, the state diff, the joins,
triage.
*Gate:* a report filed on the phone is fully explicable from the web page alone, with no Supabase
console.

**§12.3 was wrong about the LangSmith link, and this is the one correction that changes a design
decision rather than a detail.** It says "a project-search URL is a deterministic string". It is
not: a LangSmith run lives at `/o/<tenant>/projects/p/<project-uuid>/r/<run-uuid>`, three ids of
which none is derivable from a conversation id. What IS deterministic is the run's *name* —
`lesson <conversation_id>`, from both writers — so `langsmithTraceUrl` searches on that and asks the
SDK for the run's own URL. That makes the page's most valuable link a third-party network call on
render, so it is bounded by a 4 s timeout and swallows everything, exactly as the LangSmith *writes*
already do. When it comes back empty the page prints the search string instead, which is the manual
version of the same lookup — and an empty result is most often not a failure at all but a lesson
that never connected and therefore has no trace.

Three smaller departures:

- **The filters are links, not a client component.** No state, no `useSearchParams`; the URL is the
  whole of the view, so a filtered list can be pasted into a message. Same for triage, which is a
  plain `<form action={…}>` over a server action — the detail page ships no JavaScript of its own.
- **The filter values are read off the data**, not declared. A fourth provider or a triage state
  someone invented last week appears in the filter the moment a row carries it — the same decision
  `provider` and `status` make by being unconstrained text (§9).
- **The state panel calls out fields that disagree *within* one snapshot**, not just `live` vs
  `atError`. Each sentence is a hazard `tutor-session.tsx` documents having been designed against
  (`focusedLesson ≠ conversationLesson`, `owns ✗ while connected`, a held pause that never silenced,
  a keep-alive that never started). Stating them means reading the state no longer requires already
  knowing them.

Verified against the real database with `pnpm --filter web verify:reports`, which seeds one report
joined to a real lesson and conversation, exercises every function the page uses — list, facets,
detail, the transcript join, the resolved LangSmith URL, triage, and the owner scoping — and deletes
it again. `--keep` leaves the row behind so the page itself can be looked at.

`CLAUDE.md` gained the paragraph that legitimises `/ops` (D9, D12).

**S4 — hand it over. BUILT 2026-09-09.** `pnpm report <id>` / `--list` / `--since 7d` / `--json`,
plus `--owner=<sub>` and `--limit`.
*Gate:* a fresh Claude Code session, given only `pnpm report <id>`, can name the cause of a seeded
failure.

Two things the sketch did not anticipate, both about the document being read by a model:

- **An 8-character id prefix resolves.** The Send tab tells the learner to quote `report 4f2a1c9e`,
  and that string has to be the thing you can type. PostgREST exposes no prefix operator for a
  `uuid`, so the newest ids are fetched and matched here — and an ambiguous prefix fails loudly with
  the candidates rather than guessing.
- **The snapshot is printed in reading order, not `Object.keys` order.** A snapshot that came back
  out of `jsonb` is sorted by key *length* and then bytewise, which renders as `held, owns, lines,
  muted, usage, status…` — every field present and none of them near the one it must be compared
  against. `focusedLesson` and `conversationLesson` are the pair that matters most and they landed
  twenty rows apart. `orderedFields` restores §7.2's order, and the operator page had the same bug.

`diagnoseSnapshot` — the rules that turn a state dump into sentences — moved into
`apps/web/src/lib/debug-report-diagnose.ts` so the page and the script share one implementation. Two
copies would drift, and the failure would be a page and a terminal disagreeing about the same row
with no way to tell which was behind. It stays in `apps/web` rather than `packages/shared` because
both consumers are there: the snapshot's SHAPE is shared (the phone writes it), the reading of it is
not.

**Q4 stays answered "no": the script is read-only.** No `--resolve`, so it is safe to run without
thinking about what it might change; triage belongs to the operator page.

Two verification helpers exist alongside it: `pnpm verify:reports` seeds a report joined to a real
lesson and conversation, exercises the whole data layer and deletes it again, and `--keep` leaves
one behind so the page and the script have something to render.

### The gate, run 2026-09-09 — passed, and worth the trouble

Two reports were seeded and two fresh readers were each given nothing but `pnpm report <id>` and
forbidden from opening a single file:

- **A — the quota outage**, rebuilt from §1.1. `error_message` is the bare `Server error: Unknown
  error`; the cause exists only in the event's `data`. Named correctly in one sentence, with the
  right supporting inference (the token mint returned 200 in 372 ms, so the backend was healthy and
  the refusal came from the provider).
- **B — a lost transcript**, deliberately harder: **no sentence anywhere in the document names the
  cause.** A 24-line conversation ended cleanly, the save took `404 not_found`, and the recovered
  journal took the same 404 on the next launch. Named correctly from the state and the timeline
  alone.

**The readers' criticism was worth more than their answers, and five things changed because of it:**

1. **`## The error` printed only the raw message.** §1.1's exact failure, one layer up: `errorType`,
   `code` and `debugMessage` were present and buried in the last cell of a wide table forty lines
   down. A reader said so plainly. They are in the headline section now.
2. **"spooled for 20 min, i.e. the phone could not reach the server"** asserted a cause it cannot
   know, and contradicted a successful 200 in its own timeline. It states the gap and stops.
3. **The empty-transcript line asserted "a session that never connected has no transcript"** —
   false for B, which connected, collected 24 turns and failed to *save* them. Canned text naming a
   wrong cause is worse than an empty section.
4. **`diagnoseSnapshot` sounded certain.** A snapshot carries no event ordering, so the "wrong
   lesson" rule cannot tell a focus change that happened *before* the write from one that happened
   after — and reader B was led toward a mis-filing bug that had not happened, recovering only by
   discarding the section. It is now headed "Worth checking", says it is heuristic, and each line
   names what would confirm it. See the docblock in `lib/debug-report-diagnose.ts`.
5. **`Provider: elevenlabs` beside `Agent: … on openai`** read as a smoking gun to both readers and
   was noise. The registry's provider now prints only when it genuinely disagrees with the phone's —
   where it *is* a finding, meaning the version was re-pointed after that build shipped.

**A second round, after those five fixes, on the same hard fixture.** It found the cause again — and
found that two of the repairs were themselves the problem:

6. **A hedge is not good enough when the answer is in the document.** Softening the focus heuristic
   left it *"spending a paragraph on a hypothesis it could have resolved itself from data it already
   has"*. Exactly right: the ordering is in the ring, in the same document. `diagnoseSnapshot` now
   takes the events, and a rule the timeline settles prints the settled answer — *"the timeline shows
   `session.focus` moving AFTER the failure, so nothing was mis-filed. **Ruled out.**"* — instead of
   asking the reader to check.
7. **The `⚠ Provider mismatch` row was an over-correction of mine.** Fix 5 gave a piece of context
   warning styling, a bold label and a position above the actual error, on a report where it
   explained nothing. The lesson is about RANK, not presence: it is now a quiet clause on the
   `Provider` row.
8. **The live-vs-`atError` diff read as data loss** (`owns ✓→✗`, `lines 24→0`) when it was a session
   ending normally. It now says that most rows are ordinary teardown and to look for the ones that
   are not.
9. **"unknown to the server, or deleted" was a guess the script could simply resolve.** Both readers
   of the lost-transcript fixture named that ambiguity as the one thing they would have to leave the
   document for — and it covers two bugs with opposite fixes. The script holds the service-role key,
   so it now looks the lesson up and states which: no such row, soft-deleted and when, or another
   owner's. `owner_id` is in the header for the same reason.

One finding was about S2 rather than S4, and chasing it turned up a **worse bug pointing the other
way** — fixed 2026-09-09, see below.

Still open, and out of scope here: there is no request id tying a failing call in a report to a
server-side log line. That is the one join §12.3 does not have.

### The journal's retry policy, fixed 2026-09-09

A gate reader looked at the lost-transcript fixture and concluded the journal *"restores and
re-POSTs into the same 404 forever, with no terminal branch"*. **That was not true of the code** —
it was read off a fabricated timeline in the fixture. `restoreParked` cleared the journal
unconditionally, so there was exactly one attempt and no loop.

The real bug was the mirror image, and it is the more expensive one: **the journal was deleted even
when nobody had answered.** A crash followed by a relaunch with no signal — a 500, airplane mode, a
token that could not be minted — discarded the transcript along with the failure. The comment
defending it said "the post-call webhook is the backstop", which is true for ElevenLabs and Vapi and
**false for OpenAI**, whose route docblock states plainly that the client write *"is the only witness
there is"*. So on an OpenAI lesson that was total loss.

The fix is the spool's rule (§11.1) applied to the journal, and now it is literally the same rule:
`isFinalRefusal` in `apps/mobile/src/lib/retry-policy.ts`, pure, dependency-free and pinned in
`apps/mobile/check.ts`. **4xx clears** — the server looked and refused, and every future attempt
sends the same request to the same rule, which is the loop the reader feared. **Everything else
retains**, and the next focus of that lesson tries again. A new `journal.retained` code makes a
transcript stuck on a device a thing you can group by, which is a different question from "did a save
fail".

**Known gap, stated rather than papered over:** a retained journal is still cleared by the next
`start` on that lesson — the seam clears it so a stale journal cannot outlive its conversation, and
the key is per-lesson. Retention therefore buys every retry up to the next Start, not an unbounded
queue. Closing that window means keying the journal per *conversation*, which is a larger change than
this one.

A caveat on fixture B, recorded so the next reader of this section is not misled by it: its frozen
snapshot had `focusedLesson` already moved to the next lesson while its timeline puts that move
*after* the first error — and the bus freezes on the first error, so that state could not have
existed. A seeding mistake, not a product one. Both readers caught the contradiction independently,
which is its own small evidence that the format works.

Each stage ships alone. S1 alone already fixes §1.1's real gap; S2 alone makes TestFlight crashes
recoverable; S3 and S4 are convenience over the same rows.

**All four stages are built as of 2026-09-09.** What remains is device work, and only device work:
the S1 gate (force a mint failure and read the modal), the S2 gate (airplane mode → spool → land),
and the S3/S4 gates, which both need a report filed from a real phone rather than a seeded one.

---

## §16 Decisions and open questions

**Decisions taken in this research** (arguments above; each is reversible but should be argued
against, not drifted from):

- **D1** The bus is a mobile module at module scope, not React state and not a context. §4.1
- **D2** `TutorTransportEvents` does not change; adapters import the bus directly. §3
- **D3** The report carries `conversationId`, not the transcript. §6
- **D4** The snapshot includes the refs, via a registered function evaluated on open. §5
- **D5** A frozen at-error snapshot travels beside the live one. §5.3
- **D6** `sanitizeDebugReport` lives in shared and runs on both sides; unknown codes are preserved. §8
- **D7** The spool is its own kv-store queue, not the offline outbox. §11.1
- **D8** No read tool on the existing MCP server. A script is the handoff. §13
- **D9** The operator page lives under `/ops`, unlinked, and `CLAUDE.md` gains a line legitimising it. §12.1
- **D10** The modal is read-only plus Send. No session controls. §7.3

**Settled on the presented page, 2026-09-09** (https://claude.ai/code/artifact/1f4ae9ca-c83e-4e45-8cf4-909f14ce8103):

- **D11 A spooled crash report is sent silently on the next launch.** No card, no consent question.
  This deliberately does *not* follow the journal precedent, which *offers* a recovery rather than
  acting on it — and the difference is what is being handed over. A recovered journal is the
  learner's own speech, replayed into a live conversation, so it is theirs to accept; a crash report
  is machine state about a machine failure, filed to a row the same account already owns and
  carrying no transcript and no free text. Nothing in it needs a decision from the person it
  happened to, and the reports most worth having are exactly the ones nobody would stop to confirm.
  **Revisit if the learner and the developer ever stop being the same person** — that is the premise
  this rests on, and it is the only one.
- **D12 The operator page is built, under `/ops`, and `CLAUDE.md` gains the line that legitimises
  it.** §12.1 in full; the script-only fallback was declined.
- **D13 All four stages are in scope**, in the order given in §15. S3 is the stage D12 authorises.

**Open questions** — none of these blocks a stage; each can be answered while the stage that
cares about it is being built:

- **Q1 Is `feedback` the same table as `error`?** Proposed yes, with `kind`. A pure feedback message
  ("the tutor talks too fast") carries a much smaller payload and no error. The alternative — two
  tables — buys nothing while one person is filing both, and costs a join the day a feedback message
  turns out to be about a bug.
- **Q2 Retention of transcripts inside reports.** Only relevant if the §6 toggle is used often. If it
  is, the tail should be dropped from rows older than N days rather than the whole report.
- **Q3 Notification on arrival.** A Slack/email ping on insert would make "the learner filed a
  report" not depend on someone opening a page. Cheap with `after()`; deferred because it is a new
  outbound integration and the volume is one person.
- **Q4 Should `pnpm report` be able to write?** e.g. `pnpm report 4f2a --resolve "fixed in …"`. Nice
  for closing the loop from the terminal after a fix. Trivial to add; excluded from S4 to keep the
  script read-only and therefore safe to run without thinking.
- **Q5 Sampling.** Should `level: "debug"` events be dropped in production builds to keep the ring
  focused? Leaning no — the ring is 300 entries and the debug-level events (status transitions, api
  requests) are the ones that reconstruct the sequence.

---

## §17 What I would not build

- **A remote log shipper.** Continuous telemetry from one device to a server, for one user, is a bill
  and a privacy surface in exchange for data nobody reads. The report is user-triggered on purpose.
- **A third-party crash SDK** (Sentry, Bugsnag). It would do §11.2 better and everything else worse:
  it does not know what `ownsRef` is, cannot join to `lesson_sessions`, and adds a native dependency
  to a build whose native surface is already the fragile part (WebRTC ×2, LiveKit, Daily). Revisit if
  native crashes — as opposed to JS errors — become a real category.
- **A log viewer on the phone with search, export and levels-as-toggles.** Two tabs and a level
  filter cover it. The phone is where a report is *captured*; analysis happens on the machine with a
  keyboard.
- **In-app remediation.** §7.3.
- **A shared ring buffer implementation in `packages/shared`.** The web is deprecated as a client, so
  there is exactly one consumer. Shared holds the shape, not the mechanism (§3).
