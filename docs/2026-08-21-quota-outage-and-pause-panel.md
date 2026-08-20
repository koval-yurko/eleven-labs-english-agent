# The "microphone" error that was an empty wallet — and the pause panel

_2026-08-21._

Two changes, one of them prompted by a false alarm that took real time to clear.

---

## §1 — "Server error: Unknown error — if you haven't allowed the microphone yet…"

### 1.1 It is not the microphone, and it is not words-1.6

The message names the microphone because **we** appended that; the platform said nothing at all.
`apps/mobile/src/app/lessons/[id]/index.tsx` rendered every SDK error as:

```ts
onError: (message) =>
  setError(`${message} — if you haven't allowed the microphone yet, that looks like this too.`),
```

The first instinct was that words-1.6 had just become the default and broken something. The
conversation list says otherwise:

```
2026-08-20T21:23  words-1.6  status=failed
2026-08-20T21:22  words-1.6  status=failed
2026-08-20T18:34  words-1.5  status=failed      ← before 1.6 existed
2026-08-20T18:32  words-1.5  status=failed      ← before 1.6 existed
2026-08-20T07:35  words-1.3  status=done        ← 1154 s, 78 messages
```

Everything after ~18:30 on 2026-08-20 fails, on whichever agent. 1.5 had been untouched for three
days and had succeeded repeatedly before that.

### 1.2 The actual cause

`GET /v1/convai/conversations/{id}` on a failed session:

```json
"termination_reason": "This request exceeds your quota limit.",
"charging": { "tier": "starter", ... }
```

**The ElevenLabs account is out of credits.** No code change fixes that; the account needs topping
up. The 1.6 agent's live config was pulled and diffed against 1.5's at the same time and is
structurally identical (`turn_timeout: 3`, `turn_eagerness: patient`, `eleven_v3_conversational`,
the `ru` language preset, `max_duration_seconds: 1800`) apart from `max_tokens: -1`, which is what
1.0–1.3 have always run.

### 1.3 The real bug, which is ours

The platform sent an `error_event` with **no message and no reason**. `BaseConversation.handleErrorEvent`
turns that into the string `"Server error: Unknown error"` — and hands the callback a second
argument the app never took:

```js
this.onError(`Server error: ${message}`, {
  errorType, code: errorEvent?.code, debugMessage: errorEvent?.debug_message, details: errorEvent?.details,
});
```

`onError` is `(message: string, context?: any) => void`. Our handler declared one parameter, so
every field that could have named the cause was discarded while the UI said "Unknown error" — and
then blamed the microphone. Two independent defects:

1. **The hint was unconditional.** A `Server error:` is the far end refusing us; the microphone is
   not an unlikely cause there, it is a definitively wrong one. A hint that is right sometimes and
   misleading otherwise is worse than none, because it gets trusted.
2. **The diagnostics were dropped at the call site**, which is the only place they were ever
   offered.

### 1.4 The fix

`apps/mobile/src/lib/tutor-error.ts` — one pure function, three branches:

- **Quota-shaped** (`quota` / `credit` / `insufficient funds` anywhere in the message, debug text or
  error type) → says the account is out of credits and that nothing on the phone needs fixing.
- **Any other server error** (the SDK's own `Server error:` prefix, or an `errorType` being present)
  → says the service refused the session, points at credits as the usual cause **without asserting
  it**, and explicitly rules the microphone out.
- **Anything else** → keeps the microphone hint, which is where it belonged all along.

Every branch appends whatever `context` actually carried — `errorType · code N · debugMessage` —
because that string is what ends up in a screenshot. Fields are read defensively (`context` is typed
`any`), so a non-string `errorType` is dropped rather than rendered as `[object Object]`.

Detection is by substring rather than an error-code table on purpose: the failure that motivated
this arrived with an **empty** message, and the real text was only readable afterwards in
`termination_reason`. So the quota branch fires when the platform does say something and simply
does not when it doesn't — the generic server branch covers that case honestly.

Nine assertions in `apps/mobile/check.ts`, including the exact regression: a bare
`"Server error: Unknown error"` must not carry the microphone hint. One of them initially failed on
my own wording, because the server branch mentions the microphone *in order to rule it out* — the
assertion now tests for the hint sentence rather than the word, which is the property that actually
matters.

---

## §2 — The pause / ended panel is gone

Removed from the lesson screen: the `<Panel>` driven by `PAUSE_COPY`, with its four variants
("Paused", "The session dropped", "The tutor ended the session", "Your last session ended
unexpectedly") and its Continue / **Start fresh instead** button pair.

It was a second set of session controls sitting directly under the first. The row above it already
carries Start conversation, Resume, Pause and End, and the panel's primary CTA called the same
`start()` as the button one line up.

`PauseReason` itself stays, and so does everything that sets it. Two things still read it: only
`"paused"` puts a Resume button in that row, and only `"paused"` gets its own status line. The other
three reasons now exist to *not* be `"paused"` — the difference between "you stopped this" and
"this stopped" — and the resume context they park is spent by the next Start either way.

**Two things genuinely went with it**, neither replaced:

1. **"Start fresh instead."** ~~`dismissPause` was the only way to drop a parked resume context.~~
   **Resolved the same day**, and it turned out to be a defect rather than a trade-off: *Start
   conversation* and *Resume* were both calling `start()`, so the button that said "Start" had been
   resuming all along and removing the panel took away the only control that did not. Start now
   discards the parked context, Resume carries it, and End clears it — see
   `docs/2026-08-21-add-word-with-suggestions-on-lesson-page.md` §4. It belonged in that button
   row, not in a panel.
2. **The `"recovered"` notice.** A journal found at mount used to announce itself ("the transcript
   below was recovered and saved to this lesson's history"). Now the carried transcript simply
   appears above the live one with nothing explaining where it came from.

Both are consequences of the ask rather than oversights, and both are cheap to reinstate inside the
existing controls if they turn out to be missed.

---

## §3 — Verified

`tsc --noEmit`, `eslint .`, `check:logic` (nine new assertions), and `expo export` — all clean on
`apps/mobile`. §1 needed no server or shared-core change, and §2 touched one file.

**None of this makes a lesson connect.** The account is out of credits; that is the fix, and it is
not in this repository. What changed is that the next time it happens, the app says so.
