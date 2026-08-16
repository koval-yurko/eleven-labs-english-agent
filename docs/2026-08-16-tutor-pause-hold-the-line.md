# Pause by holding the line open — a pause the lesson survives

**Date:** 2026-08-16
**Scope:** the voice session on the **mobile** lesson screen
(`apps/mobile/src/app/lessons/[id]/index.tsx`). Reaches `packages/shared/src/tutor.ts` (hidden
messages, resume context) and, for the escalation path only, `apps/web/src/agent/` (a prompt version
and the sync script). No web UI work.
**Status:** **built 2026-08-16 — phases B and D, plus the §4.4 audio fix found in use the same day
(`setVolume` is a no-op on React Native, so the first held pause muted the microphone and left the
tutor talking). Unmeasured: P1/P2 need a real device.**
Pause now means *mute + heartbeat*; `endSession` is no longer on that path at all. What is **not**
built: the grace timer and automatic escalation (§4.3) — deliberately, see the note there — and §6's
`lesson_state` work. Supersedes §4.1 of
`docs/2026-08-16-tutor-session-pause-resume.md` as the working design; that document is now the lean
record of the **parked path** — the involuntary floor this one sits on — and of why reconnecting
repeats (§2 there).
Claims are tagged `[typings]` / `[source]` (read out of the pinned packages in `node_modules`),
`[docs]` (ElevenLabs documentation), `[code]` (this repo), `[unverified]` (needs a probe from §7).

---

## The ask

Pause shipped this morning as *hang up, then resume as a new conversation with the tail replayed*.
In use:

> I have a lot of repetition, so I resume not from exact same state.

Build the pause that does not do that: **keep the conversation open** while the learner is away, so
there is no state to hand over and nothing to reconstruct.

## The headline

**Reconnecting can never resume exactly, and holding the line can never fail to.** That is the whole
argument, and §1 is the proof: a resumed conversation is a *new* conversation whose strongest
instruction is a system prompt telling it to greet the learner and teach item one, handed a truncated
chat log as *background information* to argue against it. A held conversation has no such fight —
the agent's own context is still there, the prompt is never re-injected, and nothing is truncated.

Holding it is mechanically small: **mute the microphone and send `user_activity` every 3 seconds.**
The 3 seconds is not a guess — `turn_timeout` defaults to **7 s** `[docs]`, that timer is what makes
an agent re-engage into silence, and `user_activity` is documented to reset it. Everything else in
this document is the consequence of three facts that the mechanism cannot change:

1. **The microphone light stays on.** `setMuted(true)` reaches LiveKit's `track.mute()`, which stops
   the capture device *only* when the track was published with `stopMicTrackOnMute` — and the
   ElevenLabs SDK constructs its `Room` without it `[source]`. So a held pause is muted but still
   capturing, and iOS says so. §4.2.
2. **The lesson clock keeps running.** `max_duration_seconds` (1800 for us) counts wall-clock, not
   speech. A pause held for 20 minutes eats the lesson. §4.3.
3. **A held line dies with the process.** Force-quit, crash, or a long enough absence and we are back
   in mechanism B — which repeats. §6 is therefore not optional: **the fallback has to stop repeating
   too**, and that means carrying lesson *state*, not a chat log.

So the design is: hold the line for as long as it is honest and cheap to hold it, escalate to a
parked pause after that, and make the escalation land somewhere better than it lands today.

---

## §1 Why reconnect-and-replay repeats itself `[code]`

Five things compound, and no amount of prompt-wording fixes more than the last two.

| # | Cause | Where |
|---|---|---|
| 1 | The system prompt is a **script from the top** — *"Greet in one sentence and lay out the plan … start teaching the first item without waiting to be asked"* — and it is re-sent **in full** on every resume | `apps/web/src/agent/prompts/words-1.3.ts` |
| 2 | `{{items_list}}` is re-injected **whole**, with nothing marking which items are already taught | `formatItemsList`, `packages/shared/src/tutor.ts` |
| 3 | The tail is delivered as a `contextual_update` — documented as *non-interrupting background information*, i.e. explicitly the weaker signal against the prompt in (1) | `formatResumeContext` → `sendContextualUpdate` |
| 4 | Only the last **20** turns at **400** chars survive; the opening of a long lesson is gone | `RESUME_CONTEXT_TURNS` |
| 5 | What we carry is **dialogue**, never **lesson state** — nothing says which item was in progress, which are done, what the learner got wrong | the whole design |

And nothing recovers it on the platform side: there is no cross-conversation memory in the Agents
API — the documented pattern for that is a third-party memory service (Mem0 and friends), not a
feature `[docs]`. Two conversations of the same learner know nothing about each other except what the
client puts in front of them.

**The conclusion that decides the architecture:** the fidelity of a resume is bounded by the state we
can hand over, and today we hand over a truncated chat log to an agent that has been told to start
the lesson. Fix (1)–(4) and it improves; it does not become "exactly where we stopped". The only
design where "exactly" is free is the one that never lets go.

---

## §2 The mechanism

### 2.1 Pause

```
tap Pause
 1. setAgentAudioVolume(0)          // instant silence — NOT setVolume, a no-op here (§4.4)
 2. setMuted(true)                  // the learner is private from this moment
 3. mark the transcript length      // so the resume knows what went unheard (§4.4, §5)
 4. sendContextualUpdate(PAUSE_CONTEXT)
 5. heartbeat := setInterval(sendUserActivity, 3_000)
 6. keep journalling; do NOT persistSession (the conversation is still open)
```

Step 4 is belt-and-braces: the heartbeat is what actually keeps the agent quiet (§4.1); the
contextual update is there so that if a turn *does* slip through, the tutor knows why nobody is
answering and does not start a "are you still there?" spiral.

### 2.2 Resume

```
tap Resume
 1. clearInterval(heartbeat)
 2. setMuted(false)                 // LiveKit re-attaches the input analyser for us  [source]
 3. setAgentAudioVolume(1)
 4. sendContextualUpdate(formatHeldResumeContext(pausedSeconds))
 5. if an agent line arrived while held → sendUserMessage(SOFT_RESUME_MESSAGE)
    else                                → send nothing; the learner speaks first
```

Step 5 is the only place a held resume produces speech, and it is the correct place: the learner
missed the end of a sentence and needs it back (§5). A pause taken while the tutor was already
listening resumes into silence, which is exactly right — the learner is mid-thought, not mid-lesson.

### 2.3 The states

| State | Line | Mic | Agent | Clock | Survives force-quit |
|---|---|---|---|---|---|
| `connected` | open | live | teaching | running | n/a |
| `held` | **open** | **muted** | **silent (heartbeat)** | **running** | no |
| `parked` | closed | released | gone | reset on resume | yes |
| `idle` | closed | released | gone | — | n/a |

`held → parked` is the escalation (§4.3). `parked` is exactly what shipped this morning, so this
design adds one state in front of an existing one rather than replacing anything.

---

## §3 The facts it rests on

| # | Fact | Tag |
|---|---|---|
| F1 | `turn_timeout` **defaults to 7 s** (range 1–30) and is *"maximum wait time for the user's reply **before re-engaging the user**"*. We have never set it | `[docs]` + `[code]` |
| F2 | `silence_end_call_timeout` **defaults to -1 (disabled)** — nothing hangs up a silent conversation by itself. We have never set it either | `[docs]` |
| F3 | `user_activity` *"resets the turn timeout timer"*, does not affect conversation content, and is *"useful for maintaining long-running conversations during periods of silence"* | `[docs]` |
| F4 | `setMuted(true)` → `micTrackPublication.track.mute()`; `LocalAudioTrack.mute()` stops the capture device **only if `stopOnMute`**, which is set **only** when the track is published with `stopMicTrackOnMute`. ElevenLabs builds `new Room({ singlePeerConnection: false })` and never passes it. LiveKit's own comment on that branch: *"also stop the track, so that microphone indicator is turned off"* | `[source]` |
| F5 | Agents bills **conversation duration**, with a **95% discount for silence longer than 10 s**; `max_duration_seconds` is wall-clock and is not discounted | `[docs]` |
| F6 | `WebRTCConnection.sendMessage` **never throws** — it warns and returns when the room is gone, and swallows publish errors into `debug` | `[source]` |
| F7 | `onMessage` keeps delivering transcript lines while the mic is muted and the output is silenced — muting is local, the agent's turn still arrives as text | `[typings]` |
| F8 | **`conversation.setVolume()` is a no-op on React Native.** It reaches `WebRTCConnection.setAudioVolume` → `this.audioAdapter?.setVolume(v)`, and the adapter is registered only by the SDK's *web* entrypoint; `index.react-native.js` registers a setup strategy and a volume provider, never an adapter. The SDK's own docblock: *"React Native: no-op (LiveKit handles playback natively)"* | `[source]` |
| F9 | LiveKit **does** support it: `RemoteAudioTrack.setVolume()` branches on `isReactNative()` and calls `_mediaStreamTrack._setVolume(v)` — a real native gain control in `@livekit/react-native-webrtc` (0–10, default 1) that works on **remote** tracks | `[source]` |

F6 is a design constraint people get wrong: **the heartbeat cannot tell you the line died.** It
returns cleanly forever. Liveness must be read from `status` / `onDisconnect`, never from the ping.

F8 is the one that shipped broken (§4.4). It fails **silently** — no throw, no warning — so the first
held pause muted the microphone correctly and let the tutor keep teaching out loud.

---

## §4 The four problems, and their answers

### 4.1 The agent re-engages into silence — the heartbeat

Without a heartbeat the sequence is: mute → 7 s of silence → the agent takes a turn ("Still with
me?") → 7 s → another. Muting alone is not a pause; it is a pause with a tutor talking through it.

**Cadence.** `interval = turn_timeout × 3/8`, i.e. **3 s against a 7 s timeout**. That survives one
lost ping (6 s < 7 s) and not two, which is the right trade: two consecutive losses on a live WebRTC
data channel means the line is in trouble anyway, and the recovery is the same as a drop.

**Pin the timeout (D7 from the previous document).** Relying on 7 s while never setting it means a
platform default change silently makes the tutor start talking to an empty room. Add
`turn: { turn_timeout, silence_end_call_timeout }` to `agentBody()` in
`apps/web/src/agent/sync-agents.ts` **and to `hashConfig()`** — the script's own comment warns that a
field added to one and not the other reports "unchanged" while the live agent keeps the old value.
Note that `turn_timeout` also governs **live** teaching cadence, so keep it at the current default
value (7) rather than tuning it for pauses: the pin is about determinism, not about a new number.

**What a held pause must not do:** send `contextual_update` on a timer instead. It does not reset the
turn timer `[docs]`, and every one of them accretes in the agent's context for the rest of the
lesson.

### 4.2 The microphone light stays on (F4)

This is the honest problem with tier A, and it is now a **known**, not a probe: mute leaves the
capture device running, so iOS keeps the orange indicator lit through a "paused" lesson. Three
answers, in preference order:

1. **Say what is true and escalate.** Status line and card read *"paused — microphone muted"*, never
   "microphone off", and the grace window (§4.3) means the indicator goes out on its own within
   ~90 s, because parking releases the device. This is the recommendation: it is honest, it needs no
   escape hatch, and the residual exposure is bounded by a timer we control.
2. **Force the release through the raw room.** `useRawConversation()` is a documented escape hatch
   `[typings]`, and `WebRTCConnection.getRoom()` is public — but `BaseConversation.connection` is
   `protected`, so reaching the room means a cast, and `localParticipant.setMicrophoneEnabled(false)`
   unpublishes (with `stopLocalTrackOnUnpublish` defaulting to **true**, so the device *is* released
   `[source]`). Costs: the SDK's own `_isMuted` goes stale, republish-on-resume is a re-negotiation
   the ElevenLabs server may or may not like mid-conversation `[unverified]`, and the whole thing
   rests on a private field surviving SDK upgrades. **Worth probing (P6), not worth shipping first.**
3. **Ask ElevenLabs for `stopMicTrackOnMute` to be passed through** (or for room options to be
   forwarded at all). One line in their SDK, and it makes (2) unnecessary. Worth an issue regardless
   of what we build.

### 4.3 The lesson clock keeps running (F5) — the grace window

A held pause spends `max_duration_seconds` at full rate while costing ~5% of a conversation minute in
money. So money is not the reason to bound it; **the lesson is**. A learner who holds a line for 20
minutes returns to a tutor with ten minutes left before the platform ends the call.

> **Built differently, on purpose.** The automatic 90-second escalation below was **not** built.
> Escalating means calling `endSession`, and `endSession` is the mechanism whose repetition prompted
> this whole document — a timer that silently converts a deliberate pause into the lossy path would
> reintroduce the complaint on a schedule, for exactly the pauses (a doorbell, a three-minute
> conversation) that tier A exists to serve. The line now holds until one of three things takes it,
> all of which are involuntary and all of which were already handled:
>
> - **the platform's own cap** — `max_duration_seconds` is 1800, so a forgotten pause ends itself
>   within 30 minutes and lands on the existing *"The tutor ended the session"* card;
> - **the connection dying** — the existing `dropped` path, and the hold is released by the `status`
>   watcher so the screen can never offer Resume for a conversation that is gone;
> - **leaving the screen** — the unmount guard ends the call (it must; a live billed listening
>   session behind no UI is the bug it exists to prevent) and now parks it as *Paused*, so the lesson
>   is waiting on return.
>
> The trade is stated plainly: a held pause keeps the microphone open (§4.2) and spends the lesson
> clock until one of those fires. If P5 shows iOS suspending a *muted* session, or if the orange
> indicator proves intolerable in use, the timer below is the ready-made answer — it is written, it
> is just not wired.

The original design, kept for when it is needed — **escalate at ~90 s**, and also escalate
immediately when:

- the app leaves `active` (a suspended app cannot heartbeat, and iOS may suspend a session that is
  silent even though S1 proved it does not suspend a *talking* one — P5),
- the screen unmounts (the existing guard already ends the session; this only adds the marker),
- `status` leaves `connected` (the line died — fall through to today's `dropped` path unless the
  pause intent flag is set, which the shipped code already handles).

Escalation is **silent**: same card, same button. The only thing the learner can notice is that a
long pause resumes with the tutor re-orienting — which is the correct behaviour for a long pause, and
is also the behaviour §6 has to improve.

### 4.4 The tutor stays audible — `setVolume` does nothing on React Native

**Found in use, on the first held pause:** *"during pause I still hear Tutor"*. The microphone was
muted, the heartbeat was running, and the tutor kept teaching out loud.

`conversation.setVolume({ volume: 0 })` is a **silent no-op on React Native** (F8) — it resolves to
an optional call on a `null` audio adapter. Nothing throws and nothing warns, so the pause looked
correct in every way except the one that matters.

It matters more here than it would in most apps: this tutor's turns are long teaching monologues
("weave MEANING / TRANSLATION / FORMS / USAGE / SOUND into a natural spoken explanation"), and the
platform has **no way to abort a turn the agent has already started** — muting the microphone means
the server never sees an interruption, so the turn plays to the end. Without local silencing, a pause
taken mid-explanation is a minute of teaching to an empty room.

**The fix** is `apps/mobile/src/lib/agent-audio.ts`: walk the LiveKit room's remote audio tracks and
`setVolume(0)` on each, restoring `1` on release (F9). Getting to the room needs the escape hatch
that §4.2 option 2 described as "worth probing, not worth shipping first" — `useRawConversation()` is
documented, the hop from there to `connection.getRoom()` is through a `protected` field. It is no
longer optional: it is the only way to silence output on this platform.

So every step is **feature-detected rather than typed**, and the helper returns how many tracks it
reached. `0` means a future SDK renamed something, and the paused status line says *"microphone
muted, but the tutor may still be audible"* — the failure is visible in the UI instead of being
rediscovered through the speaker. Upstream, the real fix is for ElevenLabs to register an RN audio
adapter (or forward room options); worth an issue either way.

**A related gap the same report exposed.** The in-flight turn still *happens* — it is silenced, not
cancelled — and its text arrives through `onMessage` (F7). The resume therefore marks the transcript
length at pause (`heldAtLineRef`) and, if any agent line arrived while held, sends
`SOFT_RESUME_MESSAGE` so the tutor recaps what the learner missed. A mark rather than the
`isSpeaking` boolean the first version captured, because two different things produce an unheard turn
and only one is visible at the moment of the tap: the turn in flight, and any turn that slips past
the heartbeat.

---

## §5 Pausing mid-sentence

Tapping Pause while the tutor is talking has two bad options — guillotine the sentence, or make the
button feel unresponsive — and one good one.

**Silence the output immediately, let the turn finish into the void, and remember what was missed.**
Steps 1–2 of §2.1 are instant, so the learner perceives an immediate pause. The agent's remaining
audio plays to a silenced output — and it can be the whole rest of a long explanation, not a couple
of seconds, because the platform cannot abort a started turn (§4.4). The **text still arrives through
`onMessage`** (F7), so we know exactly what the learner did not hear.

Detection is a **transcript mark**, not `isSpeaking` at the moment of the tap: record
`linesRef.current.length` when the hold begins, and on release check whether any agent line arrived
after it. That catches both the in-flight turn and anything that slipped past the heartbeat, where
the boolean caught only the first. If nothing arrived, the resume is completely silent — the learner
was mid-thought and nothing was lost.

This also gives the transcript an honest rendering: an unheard trailing line can be shown dimmed or
marked, rather than pretending the learner heard it.

---

## §6 The escalation path must stop repeating too

Tier A does not remove the parked path, it *delays* it — and every fall into it lands in the
repetition diagnosed in §1. So this section is part of the work, not a follow-up.

**Carry lesson state, not a chat log.** Three layers, cheapest first:

1. **A `{{lesson_state}}` dynamic variable.** `dynamicVariables` are set per session at connect
   `[code]`, so a resumed session can be handed a compact state block: items already taught, the item
   in progress, items not started, and the learner's known trouble spots. Unlike a contextual update
   this lands **in the system prompt**, i.e. at the same strength as the instruction it has to
   override — which is precisely why the contextual update loses today (§1, cause 3).
   Cost: a new prompt version (**words-1.4**) carrying a `{{lesson_state}}` placeholder, registered in
   `dynamic_variable_placeholders` in `agentBody()`, plus a `RESUMING` branch in the prompt that
   forbids the greeting, forbids the plan recital, and forbids re-teaching a covered item unless
   asked. Versions are the repo's unit of prompt change, so this is the sanctioned way to do it.
2. **Where the state comes from — client-side first.** The screen already holds every transcript line
   and every item's text. A cheap derivation (which item texts have been spoken by the agent, and how
   recently) is enough to separate *covered* from *not started*, and it needs no server round-trip at
   the moment of resume. It will be imperfect at the margins; it cannot be worse than the current
   answer, which is no distinction at all.
3. **Where it comes from properly — the server.** `lesson_sessions.summary` already exists and is
   already written, by the post-call webhook, from ElevenLabs' own `analysis.transcript_summary`
   `[code]`. That is genuinely useful for the *previous* session but arrives **after** the call ends
   and by a path we do not control the timing of — so it cannot be depended on at the instant of
   resume. If layer 2 proves too coarse, the honest fix is a LangChain job on the existing jobs
   infrastructure producing a structured `lesson_state` (not prose), with layer 2 as the fallback
   while it is in flight. Do not build this before layers 1–2 have been measured.

**Also fix the two cheap ones from §1** while in there: raise/trim `RESUME_CONTEXT_TURNS` deliberately
rather than by inheritance, and mark covered items inside `formatItemsList` when a state block is
present so causes (2) and (4) stop pulling against the resume.

---

## §7 What to measure before building `[unverified]`

`apps/mobile/src/app/probe.tsx` is the instrument, and the S1 rules apply: **Release configuration,
no debugger, real device.**

| # | Question | Method | Pass = | Kills what if it fails |
|---|---|---|---|---|
| P1 | Does a muted session stay connected for 1 / 5 / 15 min? | hold, log `status` + `onDisconnect.reason` | no disconnect at 15 min | tier A entirely |
| P2 | Does the 3 s heartbeat keep the agent silent — and does removing it produce a re-engagement at ~7 s? | run both arms, count agent turns | 0 turns with, ≥1 without | the whole quiet-hold premise (and confirms F1/F3 on *our* agent) |
| P3 | Does the iOS mic indicator go out on `setMuted(true)`? | visual, on device | expected **no** (F4) | nothing — it confirms a known; it sets the copy |
| P4 | Does silencing work instantly mid-turn, and does `onMessage` still deliver that turn? **Half answered by use — `setVolume` did nothing (F8); re-run against `setAgentAudioVolume`.** | pause mid-sentence, compare audio vs transcript | silent + text present | §5's unheard-turn design |
| P5 | Does a *muted* session survive backgrounding, and do JS timers keep running? | `useSuspensionProbe` + a heartbeat counter across a background/foreground cycle | drift ≈ 0, counter keeps ticking | makes background escalation mandatory (it is already recommended) |
| P6 | Does `getRoom().localParticipant.setMicrophoneEnabled(false)` release the mic and re-publish cleanly on resume? | escape-hatch spike behind a runtime guard | indicator off, conversation continues after re-enable | §4.2 option 2 only |
| P7 | What does a 5-minute held pause actually cost? | `GET /v1/convai/conversations/{id}` → `metadata.charging` (`callCharge`, `freeMinutesConsumed`) | ≈5% of 5 min | the cost claim, not the design |

P1 and P2 are the gate. P3 is expected to fail (F4 predicts it) and that is fine — it decides copy.

---

## §8 Build order

| Phase | Content | Gate | State |
|---|---|---|---|
| B | Mute + 3 s heartbeat, pause/resume contextual updates, unheard-turn handling, `status` release watcher, held-pause status line, Pause/Resume on the same button | — | **built 2026-08-16** |
| D | Pin `turn_timeout` / `silence_end_call_timeout` in `agentBody()` **and** `hashConfig()` | — | **built** — `pnpm sync:agents` is **yours to run** (it PATCHes all four live agents and rewrites `agents.lock.json`; `--dry-run` shows the plan) |
| A | P1–P5 on device, Release, no debugger | B | **next** — the build is the instrument |
| C | Grace timer + `AppState` escalation | A (P5) | **held back on purpose** — see §4.3 |
| E | §6: `{{lesson_state}}` + prompt version **words-1.4** + client-side state derivation | A | planned |
| F | Optional: server-derived `lesson_state` job; escape-hatch mic release (P6) | E, P6 | idea |

Phase B was built before phase A because the two probes that matter *are* the held tier: there is no
way to ask "does a muted session stay quiet for fifteen minutes" without a muted session and a
heartbeat. It is ~90 lines; if P1 or P2 comes back bad, an afternoon is lost, not a design.

The UI is unchanged in shape from what shipped this morning — `[ End session ] [ Pause ]`, status on
its own line, the paused card. The right-hand button now flips its own label to **Resume** while the
line is held, and the card is reached only when something *took* the line.

**What landed in `packages/shared/src/tutor.ts`:** `PAUSE_CONTEXT`,
`formatHeldResumeContext(pausedSeconds)` and `SOFT_RESUME_MESSAGE` — the last also joined
`HIDDEN_KICKOFF_MESSAGES`, and is therefore filtered from the stored history by all three writers
including the webhook.

### 8.1 The implementation, in the order it runs

```
holdSession()                        releaseSession()
  setAgentAudioVolume(raw, 0)          clearInterval(heartbeat)
  setMuted(true)                       if (!connected) return  ← line died; drop path owns it
  heldAtLine := lines.length           setMuted(false)
  sendContextualUpdate(PAUSE_CONTEXT)  setAgentAudioVolume(raw, 1)
  heartbeat := every 3 s               sendContextualUpdate(formatHeldResumeContext(secs))
    → sendUserActivity()               if (agent line since heldAtLine) → SOFT_RESUME_MESSAGE
```

Three details that are not obvious from the sketch and are load-bearing:

- **`setMuted` throws** — `"No active conversation. Call startSession() first."` — so every release
  path checks `connected` first `[source]`.
- **The provider resets mute to `false` on its own `onDisconnect`** (uncontrolled mode) `[source]`,
  so a line that dies while held cannot leave the *next* session silently muted. This is why the
  screen does not pass `micMuted` as a controlled prop: controlling it would disable that reset.
- **A `status` watcher releases the hold** whenever the connection leaves `connected`, so Resume can
  never be offered for a conversation that no longer exists.
- **`setVolume` is not in this code at all** — it does nothing on React Native (F8/§4.4). Silencing
  goes through `@/lib/agent-audio`, which reaches LiveKit's remote tracks and reports how many it
  found, so the UI can admit failure instead of promising a quiet it did not deliver.

---

## §9 Rejected alternatives

| Alternative | Why not |
|---|---|
| Mute only, no heartbeat | The agent re-engages at `turn_timeout` and talks through the pause (F1) |
| Heartbeat with `contextual_update` instead of `user_activity` | Does not reset the turn timer, and every ping accretes in the agent's context for the rest of the lesson |
| Raise `turn_timeout` to its 30 s maximum and skip the heartbeat | 30 s is shorter than a real pause, and it makes the live tutor sluggish for every learner in every session |
| `setVolume(0)` alone | The tutor keeps teaching an empty room, billing TTS and LLM, filling the transcript with turns nobody heard |
| Unpublish the mic track as the *primary* pause | Reaches a private field, restarts the track on resume, and risks a mid-conversation renegotiation — a fine probe (P6), a bad foundation |
| Hold the line across screen unmount | Re-creates the live-billed-invisible-session bug the unmount guard exists to prevent |
| Hold the line indefinitely (no grace window) | Spends `max_duration_seconds` on an empty room and leaves the mic capturing (F4/F5) |
| Drop tier B now that tier A exists | Tier A cannot survive a force-quit. Parked is the floor, and the floor is already built |
| A third-party memory service (Mem0 et al.) so resumes are lossless | Solves §1 by adding a vendor to the hot path of a live lesson; layers 1–2 of §6 are cheaper and stay inside the existing architecture |

---

## §10 Open questions

1. **Grace window: 90 s, or long enough to cover a doorbell (≈3 min)?** The cost is lesson clock and
   an orange indicator, both bounded and both known — this is a product call, not a technical one.
2. **Should a held pause auto-resume when the learner speaks?** The mic is muted, so it cannot hear
   them; the alternative is not muting, which is not a pause. Probably no — but it is the first thing
   a learner will try.
3. **Does the tutor need to know a pause happened at all?** §2.2 step 4 tells it. The argument for
   silence is that a held conversation with a 40-second gap looks, to the model, exactly like a
   learner who paused to think — which is a thing this tutor already handles well.

---

## Sources

- [Conversation flow — turn timeout, max duration, soft timeout](https://elevenlabs.io/docs/agents-platform/customization/conversation-flow)
- [Create agent API reference — `turn_timeout` default 7, `silence_end_call_timeout` default -1](https://elevenlabs.io/docs/api-reference/agents/create)
- [Client to server events — `contextual_update`, `user_message`, `user_activity`](https://elevenlabs.io/docs/agents-platform/customization/events/client-to-server-events)
- [React SDK — `setMuted`, `setVolume`, `sendUserActivity`, `useRawConversation`](https://elevenlabs.io/docs/eleven-agents/libraries/react)
- [How much does ElevenAgents cost — per-minute billing and the 95% silence discount](https://help.elevenlabs.io/hc/en-us/articles/29298065878929-How-much-does-ElevenAgents-cost)

In-repo: `docs/2026-08-16-tutor-session-pause-resume.md` (the parked path, and §2's diagnosis of
why reconnecting repeats),
`docs/2026-08-13-expo-s1-background-audio.md` (suspension, `max_duration_seconds`),
`docs/2026-08-13-expo-s4-tutor-screen.md` (the pause/recovery machine).
