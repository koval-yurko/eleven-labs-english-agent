# Pause / resume for the live tutor session

**Date:** 2026-08-16
**Scope:** the voice session on the **mobile** lesson screen
(`apps/mobile/src/app/lessons/[id]/index.tsx`). `packages/shared/src/tutor.ts` is in scope (the
hidden-message contract), and `apps/web` is in scope **as the backend only** — the post-call webhook
filter and, if we pin the turn config, `apps/web/src/agent/sync-agents.ts`. No web UI work.
**Status:** **architecture approved 2026-08-16 (D1–D10). Phase 1 built the same day** — mechanism B
(hang up, resume as a new conversation), the `HIDDEN_KICKOFF_MESSAGES` webhook fix, and the button
row / status line change (§6, §8). `pnpm --filter mobile check` is green. **Mechanism A (hold the
line open) is deferred, not dropped** — it is the intended next change, and §4.1 / §7 are written to
be picked up as-is. Every claim below is tagged `[typings]` (read out of the pinned SDK in
`node_modules`), `[docs]` (ElevenLabs documentation), `[code]` (this repo) or `[unverified]` (needs
the probe in §7 before anyone builds on it).

---

## The ask

The learner is mid-lesson and needs to stop for a moment — the doorbell, a colleague, a thought they
want to finish. Today the only control is **End session**, which hangs up. They want **Pause**, and
then **Resume** into the same lesson rather than a new one.

## The headline

Three facts decide this design, and the third is the surprising one.

1. **The platform has no pause.** There is no "hold" state in the Agents API: a conversation is open
   or it is over, and a conversation that is over cannot be reopened — `POST
   /v1/convai/conversation/token` takes an `agent_id` and mints a *new* `conversation_id`; the
   conversations resource exposes `list / get / delete` and nothing that resumes (§3.6). So
   "resume" always means one of two things: **hold the line open**, or **start a second conversation
   and hand it the first one's tail**.
2. **This app already implements the second one.** The drop-recovery machinery — carried transcript,
   `formatResumeContext`, `RESUME_MESSAGE`, per-`conversation_id` save guard, the on-device journal —
   is a resume flow that fires on `reason: "error" | "agent"`. A learner-initiated pause is the same
   path with a different trigger and different copy. The missing piece is roughly **one boolean**
   (§2.3).
3. **Holding the line is genuinely viable, because of one under-used event.** `user_activity` — a
   client→server event the SDK already exposes as `sendUserActivity()` — **resets the turn timeout**
   and is documented as "useful for maintaining long-running conversations during periods of
   silence" `[docs]`. Muting the mic alone is not a pause: after `turn_timeout` the agent re-engages
   and starts talking into an empty room. Muting the mic **plus a `user_activity` heartbeat** is a
   pause the agent respects. And ElevenLabs discounts silence >10 s by 95% `[docs]`, so the held line
   is close to free in money — though **not** free in the 30-minute `max_duration_seconds` budget,
   which is what actually bounds it.

The recommendation is therefore a **two-tier pause behind one UI state**: hold the line for short
pauses (instant resume, perfect context), silently escalate to hang-up-and-resume past a grace
window (free, durable, survives a force-quit). The learner sees one **Paused** card either way.

**What was approved and built first is the second tier alone** (§5, D2). It is the half with no
unverified dependencies, it satisfies every requirement in §1, and it turns out to be a boolean, a
copy block and a parked marker — because fact 2 above was already load-bearing code. The held tier
lands on top of it later without moving anything: it changes *how* a pause is held, not what a pause
*is*.

---

## §1 What a pause has to do

| # | Requirement | Why it is not obvious |
|---|---|---|
| R1 | The tutor stops talking | Muting the *output* is not enough — the agent keeps generating, keeps billing TTS/LLM, and keeps burning the lesson clock while nobody hears it (§4.1.3) |
| R2 | The microphone stops listening | This is the honesty requirement. A card that says "Paused" while the mic is hot is a lie, and on iOS the OS indicator will contradict it (§7, P3) |
| R3 | Nothing said so far is lost | Already solved: `persistSession` + the journal `[code]` |
| R4 | Resume **continues**, never restarts | The tutor must not re-greet and re-teach item 1. Solved for drops by `formatResumeContext` + `RESUME_MESSAGE` `[code]` |
| R5 | Cost is bounded and predictable | A paused session that quietly bills for 25 minutes is worse than no pause |
| R6 | A pause survives leaving the screen, and ideally a force-quit | Today `resumeContextRef` is a `useRef` — it dies on unmount, and the unmount guard ends the session anyway `[code]` |
| R7 | One control, one state, no modes to learn | Two buttons that both stop the tutor ("Pause" vs "End") is already one more than is comfortable |

R6 is the one that quietly picks the architecture: a held line cannot survive a force-quit, so
durability has to come from the hang-up tier regardless.

---

## §2 What exists today `[code]`

### 2.1 The involuntary pause machine

`apps/mobile/src/app/lessons/[id]/index.tsx` already models "the session stopped and we can carry
on":

- `type PauseReason = "dropped" | "ended" | "recovered"` and `PAUSE_COPY` — title/body/CTA per reason
  (lines ~86–115).
- `onDisconnect(details)` maps the SDK's `reason` to a `PauseReason`, calls `persistSession()`, and
  arms `resumeContextRef.current = linesRef.current` for anything that is not `reason: "user"`.
- The kickoff effect keyed on `status === "connected"`: if `resumeContextRef` is armed it sends
  `sendContextualUpdate(formatResumeContext(...))` then `sendUserMessage(RESUME_MESSAGE)`, otherwise
  `sendUserMessage(KICKOFF_MESSAGE)`.
- `start()` moves `lines` into `carried` when resuming, so the screen shows one continuous
  conversation while each `conversation_id` is stored as its own row.
- `persistSession()` — idempotent per `conversation_id` via `savedForRef`, un-guards itself on
  failure so a retry is possible.
- The journal (`src/lib/session-journal.ts`, `expo-sqlite/kv-store`) — every transcript line written
  to the device as it arrives, replayed at mount as `PauseReason: "recovered"`.
- The unmount guard — `persistSession()` then `endSession()` if `statusRef.current === "connected"`.

`packages/shared/src/tutor.ts` owns the wire side: `KICKOFF_MESSAGE`, `RESUME_MESSAGE`,
`HIDDEN_KICKOFF_MESSAGES`, `formatResumeContext` (last **20** turns, 400 chars each).

### 2.2 Fixed session inputs (constrain the resume design)

- `dynamicVariables.items_list` is baked at `startSession` — the screen already says *"Changes apply
  to your next conversation."* A resumed conversation therefore **picks up word-list edits made
  during the pause**, which is a small feature, not a bug, but the copy should not promise it.
- `max_duration_seconds: 1800` per conversation (`DEFAULT_MAX_DURATION_SECONDS`, `apps/web/src/agent/
  prompts/index.ts`), pinned because the platform default of 600 s was cutting lessons off.
- `first_message: ""` — the agent never speaks first; a session only starts talking because the
  client sends a hidden user message.

### 2.3 What was missing (all four closed by phase 1 — §6)

1. **No user intent.** `reason: "user"` deliberately produces no card ("the learner pressed End and
   does not need to be told what they just did"). A pause is `endSession()` **with** intent, so the
   screen needs to distinguish *I hung up* from *I paused* — one `pauseIntentRef` boolean read in
   `onDisconnect`.
2. **No durable resume context.** `resumeContextRef` is memory-only, and `persistSession()` clears
   the journal on success — so after a hard pause the tail exists **only on the server**
   (`LessonDetailResponse.sessions[0].transcript`, already fetched by this screen). That is a gift:
   durability for free, if the pause marker records which `conversation_id` to read back (§6.4).
3. **No pause control, no paused status line, no transcript divider.**
4. **A pre-existing leak that this feature makes worse** (§4.2.3): the post-call webhook filters only
   `KICKOFF_MESSAGE`, not the whole `HIDDEN_KICKOFF_MESSAGES` list.

---

## §3 What the platform actually offers

Read out of the pinned packages: `@elevenlabs/react-native@1.2.18` → `@elevenlabs/react@1.12.0` →
`@elevenlabs/client@1.17.0`.

### 3.1 The client surface `[typings]`

`useConversation()` returns, among others:

| Member | What it is |
|---|---|
| `setMuted(isMuted)` / `isMuted` | microphone mute — `ConversationInput` → `conversation.setMicMuted()` |
| `sendUserActivity()` | sends `{ "type": "user_activity" }` (`BaseConversation.js:449`) |
| `sendContextualUpdate(text)` | sends `{ "type": "contextual_update", text }` — context, no turn |
| `sendUserMessage(text)` | injects a user turn — triggers a reply |
| `setVolume({ volume })` | **local playback** gain, 0–1 |
| `mode` / `isSpeaking` / `isListening` | turn state, from `onModeChange` |
| `status` | `"disconnected" \| "connecting" \| "connected" \| "error"` |
| `endSession()` / `startSession(opts)` | the only lifecycle verbs — **there is no `pause()`** |

`useConversation` also accepts `micMuted?: boolean` as a controlled prop, and `ConversationProvider`
accepts `isMuted` / `onMutedChange` — so mute state can live above the screen if we ever want a pause
to survive navigation with the line held (we do not; see D6).

### 3.2 What `setMuted` really does on React Native `[typings]`

`VoiceConversation.setMicMuted` → `WebRTCConnection.input.setMuted` (`utils/WebRTCConnection.js:66`):
it sets `_isMuted` immediately (so the volume/frequency meters read 0 even if the track op fails),
then calls **`micTrackPublication.track.mute()`**, falling back to
`localParticipant.setMicrophoneEnabled(!isMuted)` if that throws. On unmute it re-attaches the input
analyser because LiveKit may have swapped the underlying `MediaStreamTrack`.

Consequence worth measuring: `LocalAudioTrack.mute()` mutes the published track but does **not**
necessarily stop capture — livekit-client only stops the mic track on mute when the room was
constructed with `stopMicTrackOnMute`, and the ElevenLabs SDK builds the `Room` internally, so we
cannot pass that option. **If capture continues, iOS keeps showing the orange microphone indicator
during a "paused" lesson** `[unverified — probe P3]`. R2 says the UI must not claim more than the OS
shows.

### 3.3 `setVolume` is not a pause `[typings]`

It is local output gain only. The agent keeps generating text and TTS, `onMessage` keeps appending
transcript lines, and the conversation keeps billing. Useful as a *supplement* (silence a
half-finished sentence instantly), never as the mechanism.

### 3.4 `user_activity` — the event that makes holding the line work `[docs]`

> User activity events serve as indicators to prevent interrupts from the agent. **They reset the
> turn timeout timer.** The event does not affect conversation content or flow and is **useful for
> maintaining long-running conversations during periods of silence.**

Also documented: the agent "will pause speaking for approximately 2 seconds after receiving this
signal". Both halves are exactly what a pause needs — and both need confirming against our agent
before we ship (probe P2).

### 3.5 `contextual_update` `[docs]`

`{ "type": "contextual_update", "text": "..." }` — "non-interrupting background information … without
disrupting flow." This is how the tutor is told a pause happened, on both tiers, without making it
say anything about it.

### 3.6 There is no server-side resume `[typings]` + `[docs]`

- `ConversationsGetWebrtcTokenRequest` = `{ agentId, participantName?, branchId?, environment? }` —
  no `conversation_id` to continue.
- `ConversationsClient` = `getSignedUrl, getWebrtcToken, list, get, delete, getSipMessages`. Nothing
  resumes.
- Our own token route (`apps/web/src/app/api/v2/words-agent/token/route.ts`) treats the returned
  `conversation_id` as the row key and refuses to invent one — correct, and it means **every resume
  is a new row in `lesson_sessions`**, exactly as a drop-recovery is today.

So: continuity across a hang-up is a *prompting* problem (replay the tail as context), not an API
capability. That is what `formatResumeContext` is.

### 3.7 Timeouts and money `[docs]` + `[typings]`

`TurnConfig` (`@elevenlabs/elevenlabs-js`) carries the levers that matter while nobody is speaking:

- `turnTimeout` — "maximum wait time for the user's reply **before re-engaging the user**". Range
  **1–30 s**; the docs page does not state the platform default, and **we never set it**, so today's
  value is whatever ElevenLabs defaults to `[unverified — probe P2]`.
- `silenceEndCallTimeout` — "maximum wait time since the user last spoke **before terminating the
  call**". Also never set by us. A platform default change here would silently hang up paused
  sessions.
- `maxDurationSeconds` — 60–7200, we set 1800. **A held line spends this budget at full rate.**
- Billing: Agents bills on **conversation duration**, not compute — "a call on hold or with a silent
  caller still accrues cost" — but with a **95% discount for silence periods longer than 10 seconds**
  `[docs]`. At the ~$0.08–0.10/min overage rate, a five-minute held pause costs on the order of
  **$0.02**, plus zero LLM (no turns are taken). The real cost of a held pause is the lesson clock,
  not the invoice.

### 3.8 The post-call webhook fires only when the conversation ends `[code]`

So a held pause writes nothing; a hard pause writes the segment immediately (our own
`persistSession`) and then again via the webhook — the existing three-writer, one-row design, which
`sanitizeTranscript` exists to keep consistent.

---

## §4 The three mechanisms

### 4.1 Mechanism A — **soft pause**: hold the line

**Pause:**
1. `setVolume({ volume: 0 })` — instant silence, in case the agent is mid-sentence.
2. `setMuted(true)` — R2.
3. `sendContextualUpdate(PAUSE_CONTEXT)` — "the learner has stepped away and cannot hear you; do not
   speak until they return."
4. Start a `user_activity` heartbeat (§4.1.2).
5. Keep journalling; do **not** call `persistSession` (the conversation is still open, and the row
   key is still in flight).

**Resume:** stop the heartbeat → `setMuted(false)` → `setVolume({ volume: 1 })` →
`sendContextualUpdate(RESUME_CONTEXT(pausedForSeconds))` → and *only if the pause cut an agent turn*,
`sendUserMessage(SOFT_RESUME_MESSAGE)` so the tutor restates the sentence the learner never heard.

#### 4.1.1 The mid-sentence problem, and the better answer

Tapping Pause while the tutor is talking either guillotines the sentence (rude, and the transcript
then shows text the learner never heard) or waits (unresponsive).

The nice resolution uses state the SDK already gives us: **pause at the turn boundary when the
boundary is close.** On tap, immediately `setVolume(0)` + `setMuted(true)` (the learner is
*instantly* private and silent — that is the part they can perceive), then let the agent finish into
the void for up to ~2 s watching `isSpeaking`. Whatever it said while muted still arrives through
`onMessage`, so we know exactly what was missed — mark the last agent line "unheard" and let the
resume nudge restate it. This is strictly better than guessing, and it costs one boolean and one
timer.

#### 4.1.2 Heartbeat cadence

`user_activity` resets the turn timer, so the interval must be **comfortably below `turn_timeout`**.
Since `turn_timeout` is currently unpinned (§3.7), the honest move is to **pin it** in `agentBody()`
— say 8 s, near the documented middle of the 1–30 s range — and heartbeat every **3 s** (≈⅜ of the
timeout, so one dropped packet is not a re-engagement). Two cautions:

- Anything added to `agentBody()` **must** also go into `hashConfig()`, or `pnpm sync:agents` reports
  "unchanged" while the live agent keeps the old value — the sync script says so in a comment, and it
  is the exact silent drift the lockfile exists to prevent `[code]`.
- Pinning `turn_timeout` changes **live teaching cadence** too, not just pauses. It is a prompt-level
  behaviour change and belongs to a version bump if it moves far from the current default.

While the app is foregrounded the heartbeat is an ordinary `setInterval`. Backgrounded it is not:
JS timers only keep running because the app holds `UIBackgroundModes: ["audio"]` and is not suspended
— which S1 established for a *talking* session and never tested for a *silent muted* one `[unverified
— probe P5]`. If iOS suspends a muted session, the heartbeat stops, the turn timer fires, and the
tutor starts talking to a locked phone. That single unknown is why soft pause must not be the only
tier.

#### 4.1.3 Properties

| | |
|---|---|
| Resume latency | **~0 ms** — no token, no connect, no re-kickoff |
| Continuity | **Perfect.** The agent keeps its own context; no 20-turn truncation, no re-injected prompt |
| Money | ~5% of wall-clock (silence discount) + $0 LLM `[docs]` |
| Lesson clock | **Full rate against `max_duration_seconds`** — this is the binding constraint |
| Durability | **None.** Force-quit, crash, or navigating away (the unmount guard ends the session) loses the held line — it degrades into the existing `"recovered"` flow |
| New failure mode | Network drops while paused → `onDisconnect(reason: "error")` → today's `"dropped"` card. Acceptable, but the copy must not say "the session dropped" to someone who deliberately paused |

### 4.2 Mechanism B — **hard pause**: hang up, resume as a new conversation

**Pause:** set `pauseIntentRef = true` → `endSession()`. `onDisconnect(reason: "user")` then does
what it already does for drops — `persistSession()`, arm `resumeContextRef` — plus, because the
intent flag is set, `setPause("paused")` instead of nothing.

**Resume:** the existing `start()`, unchanged. It mints a token, moves `lines` into `carried`, and
the kickoff effect sends `formatResumeContext` + `RESUME_MESSAGE`.

#### 4.2.1 Properties

| | |
|---|---|
| Resume latency | token fetch + LiveKit connect + kickoff turn — **~1–3 s to first word** `[unverified — probe P4]` |
| Continuity | Last **20** turns, 400 chars each, replayed as context. Fine for a 6-word lesson; lossy for a long one |
| Money | **$0 while paused.** On resume: one full system-prompt injection (the words-1.3 prompt plus `items_list`) — real input tokens, once per resume |
| Lesson clock | **Resets** — the resumed conversation gets a fresh 1800 s |
| Durability | **Full.** The tail is on the server before the pause card renders; it survives force-quit, app update, another device |
| Cost to history | One extra `lesson_sessions` row per pause — already true for drops, and the screen already shows carried turns as one conversation |

#### 4.2.2 The one honest wrinkle

The resumed tutor **says something** ("Right — we were on *seize*…"). For a 20-second pause that is
odd; for a 5-minute one it is exactly right. This asymmetry is the entire argument for the tiered
design: short pauses want tier A, long ones want tier B, and the threshold is a number, not a
judgement call the learner should have to make.

#### 4.2.3 A pre-existing bug this feature would amplify `[code]` — **fixed 2026-08-16**

`apps/web/src/app/api/words-agent/elevenlabs-webhook/route.ts:129` filters
`t.message === KICKOFF_MESSAGE` — **only** the first constant, not `HIDDEN_KICKOFF_MESSAGES`. So
`RESUME_MESSAGE` leaked into any transcript the webhook wrote last (*"We got cut off. Pick up
exactly where we stopped…"* attributed to the learner). Adding a third hidden message multiplies the
leak. It was fixed first, in one line, independently of everything else — the array is imported and
`.includes()` matches both client filters (§6.2).

### 4.3 Mechanism C — **tiered**, one UI state (recommended)

```
                 tap Pause
   connected ─────────────────► held (mic muted, heartbeat, line open)
       ▲                            │
       │ tap Resume (instant)       │ grace window elapses (≈90 s)
       │                            │ OR app backgrounded > grace
       │                            │ OR heartbeat/network fails
       │                            ▼
       └───────── start() ───── parked (disconnected, transcript on server,
              (~1-3 s, tutor           resume marker persisted)
               re-orients)             │
                                       │ screen unmounts / app restarts
                                       ▼
                                   parked, recovered from storage at mount
```

The learner sees **one** card: *"Paused — Resume"*. The escalation is invisible; the only observable
difference is that a long pause resumes with the tutor briefly re-orienting, which is what a learner
returning after five minutes wants anyway.

### 4.4 Side by side

| | A — hold the line | B — hang up + resume | C — tiered |
|---|---|---|---|
| Resume feel | instant, mid-thought | ~1–3 s, tutor re-orients | instant when short, re-orients when long |
| Agent context | full | last 20 turns | full when short, 20 turns when long |
| Cost while paused | ~5% of a conversation minute | zero | ~5% for ≤ grace, then zero |
| Burns the 1800 s lesson clock | yes | no (resets) | bounded by the grace window |
| Survives unmount / force-quit | no | yes | yes (via the parked tier) |
| `lesson_sessions` rows | 1 | 1 per segment | 1 per *long* pause |
| Code delta | new hook + heartbeat + agent config pin | ~1 boolean + copy + a persisted marker | both, plus one timer |
| Depends on unverified behaviour | **yes** (P2, P3, P5) | no | degrades to B if the probes say no |

---

## §5 Recommendation

**Build B first, then A behind it, and let C fall out of the two.** Approved as written; D1–D2 and
D8–D10 are built.

- **D1 — Pause is a first-class `PauseReason`, not a new subsystem. ✅ built.** `"paused"` joins the
  existing union and `PAUSE_COPY`. Everything downstream (the card, the resume CTA, `carried`, the
  kickoff effect) already worked.
- **D2 — Phase 1 ships mechanism B only. ✅ built.** It is a boolean, a copy block and a persisted
  marker, it has **zero unverified dependencies**, and it satisfies R1–R6. Ship it, then measure.
- **D3 — Phase 2 adds the held tier**, gated on probes P2/P3/P5 (§7) coming back green. **This is
  the next change on this feature**, not a maybe: mechanism B costs a reconnect and a re-orienting
  sentence on every pause, and for a ten-second pause both are noise. If P3 says the iOS mic
  indicator stays lit while muted, the card copy must say "microphone muted" rather than "microphone
  off", or we skip tier A entirely — we do not ship a privacy claim the OS contradicts.
- **D4 — Grace window ≈ 90 s, escalation silent.** Long enough to cover the pauses that want
  instant resume (a thought, a sip, a sentence to someone in the room), short enough that at most
  ~1.5 min of the 1800 s lesson clock and ~$0.01 is ever spent holding a line.
- **D5 — Escalate on background too.** The product's reason to exist is that a *talking* session
  survives a locked screen (S1). A *paused* one has no such need, and a suspended app cannot
  heartbeat. Backgrounding a held pause parks it.
- **D6 — Do not hold a line across navigation.** The unmount guard stays exactly as it is: leaving
  the screen parks the pause (persist → end). Holding a line for a screen nobody is looking at is the
  live-billed-invisible-session bug the guard was written to prevent.
- **D7 — Pin `turn_timeout` and `silence_end_call_timeout` in `agentBody()`** (and in `hashConfig()`)
  before relying on either. Today both are platform defaults we have never read, which means a
  paused session's behaviour is defined by a value we do not control.
- **D8 — Fix the webhook filter now (§4.2.3), independent of everything else. ✅ built.** The
  webhook filters `HIDDEN_KICKOFF_MESSAGES.includes(...)` rather than one constant, and the array's
  docblock now says why that is the rule.
- **D9 — Two button slots, and the status line moves below them. ✅ built.** The session verb
  (`Start conversation` / `End session`) keeps the left slot; the pause verb (`Pause` / `Resume`)
  takes the right one. The status text used to sit third in that row, where two buttons leave it no
  width; it is now its own line underneath. See §8.
- **D10 — The paused card is not an alert. ✅ built.** `Panel tone="warn"` stays for the three
  accidents (`dropped`, `ended`, `recovered`); `paused` renders plain. A warning border around the
  learner's own decision would tell them something went wrong.

---

## §6 What phase 1 built

Four files. No new hook, no new route, no new table, no schema change — the pause rides the
drop-recovery path that already existed (§2.1).

### 6.1 `packages/shared/src/tutor.ts`

- **`PAUSE_RESUME_MESSAGE`** — the hidden kickoff for a resumed *pause*, beside `RESUME_MESSAGE`.
  Separate constants because the difference between them is spoken aloud: `RESUME_MESSAGE` says "we
  got cut off", which is a small lie to tell someone who pressed Pause, and the tutor's re-orienting
  sentence would repeat it back to them.
- **`HIDDEN_KICKOFF_MESSAGES`** gains the new constant, and gains a docblock saying that every
  transcript writer must filter on the **array** — with the webhook bug named as the reason it says
  so. The shared-core test in `CLAUDE.md` ("could I fix a bug here by deploying the web app alone?")
  puts these here: the webhook filters on them too.
- **`ResumeCause = "interrupted" | "paused"`** and `formatResumeContext(lines, cause =
  "interrupted")`. Only the preamble changes: `"paused"` tells the tutor the learner stepped away on
  purpose and **not to remark on the gap**. The default keeps the web's single-argument call site
  behaving byte-identically.

The soft-pause constants sketched here before (`PAUSE_CONTEXT`, `formatPauseResumeContext`,
`SOFT_RESUME_MESSAGE`) are **not** added yet — nothing sends them until tier A exists, and a shared
constant with no caller is a contract nobody is holding.

### 6.2 `apps/web` — the webhook filter (D8)

`apps/web/src/app/api/words-agent/elevenlabs-webhook/route.ts` imports `HIDDEN_KICKOFF_MESSAGES` and
filters with `.includes(t.message)`. That is the whole fix, and it retires the pre-existing
`RESUME_MESSAGE` leak (§4.2.3) independently of pause.

`sync-agents.ts` is **untouched** — D7 (pinning `turn_timeout` / `silence_end_call_timeout`) belongs
to phase 2, because nothing in phase 1 sits through a silence.

### 6.3 `apps/mobile/src/lib/session-journal.ts` — the parked pause

`PausedSessionEntry` + `writePauseMarker` / `readPauseMarker` / `clearPauseMarker`, under
`paused:<lessonId>` in the same `expo-sqlite/kv-store` as the journal, and best-effort in exactly the
same way (a storage failure must never break ending a session).

**A separate key, not a flag on the journal**, because the two mean opposite things: a journal is a
transcript *the server may not have* — insurance, cleared the moment it does — while a marker is a
transcript the server already took and the learner intends to continue. Folding them together would
make "clear the journal after saving", the one line that keeps the recovery card honest, also throw
away the pause. The marker carries its own `lines` rather than reading them back from
`LessonDetailResponse.sessions`, so the restore needs no network, makes no assumption about which
fetch lands first, and still works when the save that preceded the pause failed.

### 6.4 `apps/mobile/src/app/lessons/[id]/index.tsx`

- `PauseReason` gains `"paused"`; `PAUSE_COPY.paused` is the one entry that is an intent rather than
  an accident, so it neither apologises nor explains — it says only what the learner cannot see, that
  the conversation was saved.
- **`pauseIntentRef`** is the whole mechanism. `endSession()` reports `reason: "user"` for **both**
  buttons, so intent cannot be read off the transport and is recorded on the way out instead.
- `pauseSession()` sets the flag and calls `endSession()`. `onDisconnect` reads it once, clears it,
  and then: `setPause("paused")` — intent **wins over** `reason`, so a connection that dies in the
  half-second after the tap still reads as *Paused* rather than *The session dropped* — arms the
  resume context with `cause: "paused"`, and parks the marker.
- `resumeContextRef` becomes `{ lines, cause }` — **one** ref rather than a pair, because a cause
  that can drift out of sync with its lines eventually describes the wrong conversation, out loud.
- The kickoff effect picks `PAUSE_RESUME_MESSAGE` vs `RESUME_MESSAGE` off `cause`. **Resume is
  `start()`, unchanged** — the same call the Resume button, the paused card and the drop card make.
- The mount effect now checks two things in order: a **journal** (crash — unchanged behaviour, and it
  clears any marker, because both existing means the save at pause time failed, so the unsaved copy
  is the one that must reach the server and "ended unexpectedly" is then the true copy), otherwise a
  **marker** (restore `carried`, arm the context, show the card — nothing to push, it is already
  saved).
- `start()` and `dismissPause()` clear the marker, so a spent or a declined pause cannot be offered
  again at the next mount.
- UI per D9/D10 (§8).

**Deliberately unchanged:** the unmount guard still *ends* a live session rather than parking it.
Leaving the screen is not pausing, and D6 says the same thing from the other direction.

### 6.5 Phasing

| Phase | Content | Depends on | State |
|---|---|---|---|
| 1 | Webhook filter fix; `"paused"` reason; pause intent; parked marker + mount restore; card, buttons and status line | nothing | **built 2026-08-16** |
| 1b | Probes P1–P6 on `/probe` (§7), on device, Release, no debugger | phase 1 | **next** |
| 2 | Held tier: mute + `user_activity` heartbeat + contextual updates; pin `turn_timeout` / `silence_end_call_timeout` (D7); turn-boundary pause; unheard-turn restatement | P2, P3, P5 | planned |
| 3 | Escalation timer + `AppState` escalation, behind the one card phase 1 already renders | phases 1–2 | planned |
| 4 | Optional: summarise the tail instead of replaying 20 raw turns, so long lessons resume with better context | — | idea |

Phase 1 first is what makes phase 2 cheap: the card, the copy, the marker, the resume path and the
`cause` plumbing are all tier-agnostic. Tier A adds a *held* state in front of them and an escalation
into them — it does not revisit them.

---

## §7 What must be measured before phase 2 `[unverified]` — **phase 1b, next**

`apps/mobile/src/app/probe.tsx` is the instrument for exactly this kind of question, and the S1 rules
still apply: **no debugger, Release configuration**.

| # | Question | Method | Kills what if it fails |
|---|---|---|---|
| P1 | Does a muted WebRTC session stay connected for 1 / 5 / 15 minutes? | hold, watch `status` and `onDisconnect.reason` | tier A entirely |
| P2 | Does the agent stay silent while muted **with** the heartbeat — and does it re-engage **without** it? | run both arms, count agent turns | the heartbeat design (and tells us the real `turn_timeout`) |
| P3 | Does the iOS microphone indicator go out on `setMuted(true)`? | visual, on device | the "microphone off" copy — possibly tier A (R2) |
| P4 | Hard-resume latency: tap → first agent audio | timestamp `start()` → first `onMessage` with `role: "agent"` | nothing; it calibrates the grace window and the copy |
| P5 | Does a *muted* session survive backgrounding, and do JS timers keep running? | `useSuspensionProbe` + heartbeat counter while backgrounded | D5 (makes background-escalation mandatory rather than a nicety) |
| P6 | What is a held pause actually billed? | `GET /v1/convai/conversations/{id}` → `metadata.charging` (`callCharge`, `freeMinutesConsumed`) after a 5-min held pause | the cost claim in §4.1.3 |

---

## §8 UI and copy — as built

**Two button slots, and the status line moved below them (D9).** The row used to be
`[ Start / End ] [ status text ]`; the status text is now its own line, because a two-button row
leaves it no width and it wrapped under half a button.

```
 connected        [ End session ]        [ Pause ]
                  ● listening — just talk to interrupt

 paused           [ Start conversation ] [ Resume ]
                  ⏸ paused — resume when you're ready

 idle             [ Start conversation ]
                  status: disconnected
```

- **The left slot is the session verb, the right slot is the pause verb**, and neither moves. "End
  session" keeps meaning *finished, save it, I am done*; "Start conversation" while paused means
  *start fresh*, the same thing the card's secondary action says in words.
- **The right slot is empty, never disabled**, when there is nothing to pause and nothing paused. A
  greyed-out Pause on an idle screen advertises a control the learner cannot reach yet.
- **The status line is derived, not raw.** A paused session is `disconnected` at the transport, so
  printing the status there would say *status: disconnected* to someone looking at a Resume button.
- **The paused card is a plain `Panel`** (D10) — `tone="warn"` stays for the three accidents. Title
  *"Paused"*, body *"The tutor is waiting. Everything said so far is saved — pick up where you
  stopped whenever you're ready."*, CTA *"Resume session"*, secondary *"Start fresh instead"* (the
  existing `dismissPause`, which now also clears the parked marker).
- **The transcript reads as one conversation.** Resuming moves the previous turns into `carried` and
  renders them above the new ones, exactly as a recovered drop already did — the learner sees one
  lesson even though the server holds two rows.
- **Never auto-pause on background.** A locked screen mid-sentence is the exact scenario the native
  app exists to keep alive; pausing there would re-introduce the browser behaviour on purpose.
- **A drop while paused must not say "the session dropped."** Handled at the source: intent beats
  `reason` in `onDisconnect` (§6.4).

Still open for phase 2: the held tier wants a *third* status string (`⏸ paused — microphone muted`)
and a transcript divider, and the microphone wording is the one that has to wait for probe P3.

## §9 Alternatives considered and rejected

| Alternative | Why not |
|---|---|
| `setVolume({volume: 0})` alone | The tutor keeps teaching an empty room — billing TTS and LLM, filling the transcript with turns nobody heard. Violates R1 |
| Raise `turn_timeout` to its 30 s maximum instead of heartbeating | 30 s is shorter than a real pause, and it makes the *live* tutor sluggish for every learner in every session |
| Tell the agent in the prompt to "stay quiet if the learner says pause" | Leaves the mic hot (R2), depends on the model complying, and gives no client state to render |
| A `pause_lesson` **client tool** the agent calls | Requires the learner to *say* "pause" and the agent to take a turn to acknowledge — slower and less reliable than a button, and still does not mute anything |
| Resume the same `conversation_id` server-side | Does not exist (§3.6) |
| Switch to `textOnly` during a pause | Not a transport the RN SDK supports for this session, and it would not stop the conversation clock anyway |
| Keep the line held across navigation, in `ConversationProvider` | Re-creates the live-billed-invisible-session bug the unmount guard exists to prevent (D6) |

---

## §10 Open questions for the product call

1. **Is the grace window a constant or a preference?** D4 says constant (90 s). A "keep the line open
   while I'm away" toggle is a setting nobody will find and everybody will misread as free.
2. **Does a paused lesson expire?** A parked pause could sit for a week; resuming into a two-day-old
   context is odd. Suggestion: park markers older than ~24 h restore the card as *"Continue this
   lesson"* rather than *"Resume"* — same mechanism, honest copy.
3. **Does the word list edited during a pause apply on resume?** It does, mechanically (§2.2). Worth
   saying so in one line of copy, since the panel currently promises the opposite for a *running*
   session.

---

## Sources

Platform documentation and pricing statements used above:

- [Conversation flow — turn timeout, max duration, soft timeout](https://elevenlabs.io/docs/agents-platform/customization/conversation-flow)
- [Client to server events — `contextual_update`, `user_message`, `user_activity`](https://elevenlabs.io/docs/agents-platform/customization/events/client-to-server-events)
- [React SDK — hooks, `setMuted`, `setVolume`, `sendUserActivity`](https://elevenlabs.io/docs/eleven-agents/libraries/react)
- [React Native SDK](https://elevenlabs.io/docs/agents-platform/libraries/react-native)
- [How much does ElevenAgents cost — per-minute billing and the 95% silence discount](https://help.elevenlabs.io/hc/en-us/articles/29298065878929-How-much-does-ElevenAgents-cost)
- [ElevenLabs — we cut our pricing for Conversational AI](https://elevenlabs.io/blog/we-cut-our-pricing-for-conversational-ai)

In-repo prior art: `docs/2026-08-13-expo-s1-background-audio.md` (suspension, `max_duration_seconds`),
`docs/2026-08-13-expo-s3-conversation-token.md` (the authoritative `conversation_id`),
`docs/2026-08-13-expo-s4-tutor-screen.md` (the pause/recovery machine, D35).
