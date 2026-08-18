# Podcast mode — a tutor that keeps talking and never waits

**Date:** 2026-08-18
**Scope:** a new prompt version (`apps/web/src/agent/prompts/words-1.5.ts`), one new baked config
field (`turn_eagerness`), and the heartbeat constant the held pause runs on
(`packages/shared/src/tutor.ts` → `apps/mobile/src/app/lessons/[id]/index.tsx`).
**Status:** research + build, same day. Marked ✅ in §8 as each piece landed.
Follows `docs/2026-08-17-short-turns-and-chunked-pause.md`, which shipped words-1.4 the day before
and is the direct cause of the complaint below. Fact tags as in that document: `[docs]`, `[source]`,
`[code]`, `[unverified]`.

---

## The ask

> after implementation I have a lot of questions from Agent, so I am interrupted each time and
> should answer some questions. it is not correct.
> I want to have **Podcast format**, so tutor explain me words and do not ask any questions.
> Tutor may have short questions like *'Continue or go deeper?'* but still should not wait for my
> answer too long. **if no answer — continue**.
> If I have a questions — I will interrupt tutor and ask them.

## The headline

**words-1.4 was told to do this.** Yesterday's fix for 100-second monologues was a four-sentence
budget plus a hard rule:

> END EVERY TURN by handing the floor back with something short and answerable … Then WAIT. Say
> nothing more until the learner answers. `[code]`

That is a question every four sentences by construction. The chunking was right; the hand-back was
the wrong way to end a chunk. **Podcast mode keeps the short chunks and deletes the hand-back.**

The mechanical half is less obvious. A conversational agent has no "keep narrating" mode — it takes
a turn, finishes, and waits. The only thing that makes it speak again into silence is
**`turn_timeout`**, *"maximum wait time for the user's reply before re-engaging the user"*, which we
pin at **7 seconds** `[docs]` + `[code]`. So:

- **`turn_timeout` is the inter-chunk gap.** It is what the learner experiences as "the tutor is
  waiting for me". Seven seconds of silence after every four sentences reads as a question even when
  no question was asked.
- **What the tutor says when it re-engages is not configurable** — it is generated from the system
  prompt and the history. The docs promise only that the agent *"prompts for a response"* `[docs]`,
  and left alone an LLM prompts for a response by asking one. **The prompt has to define
  re-engagement as "continue the lesson"**, or a shorter timeout just means being asked "are you
  still with me?" twice as often.

Podcast mode is therefore exactly three changes: **shrink the gap** (`turn_timeout` 7 → 3), **tell
the prompt what silence means** (continue, never check in), and **stop requiring a question at the
end of every chunk**. Plus one thing that is not optional, §3.

---

## §1 What changes, and what deliberately does not

| | words-1.4 (yesterday) | words-1.5 (podcast) |
|---|---|---|
| turn length | ≤ 4 sentences, one thread | **unchanged** |
| end of a turn | a question the tutor waits for | a natural stop; **no question, no waiting** |
| silence from the learner | the lesson stalls until they speak | **the lesson continues** |
| comprehension checks | required ("say it back to me") | **gone** |
| optional asides | — | allowed ("want to go deeper?") but **never waited on** |
| learner's way in | answering | **interrupting** — barge-in, which already works |
| `turn_timeout` | 7 s | **3 s** |
| `max_tokens` | 220 | **unchanged** |

The short chunk survives on purpose, and it matters more here than it did yesterday. In podcast mode
the gaps between chunks are the **only** places barge-in is comfortable — a learner cutting into a
four-sentence chunk waits at most a few seconds for a natural opening, where one cutting into a
two-minute monologue has to talk over the tutor. Short chunks are what make "I will interrupt you"
a real interface rather than a fight.

## §2 The mechanism

```
tutor speaks a chunk (≤ 4 sentences)
        │
        └──► turn ends, agent listens
                 │
                 ├── learner speaks within 3 s ──► agent answers them (barge-in also lands here)
                 │
                 └── silence for 3 s ──► turn_timeout fires ──► agent takes another turn
                                                                     │
                                          the prompt decides what that turn IS:
                                          "continue the lesson", not "are you still there?"
```

Nothing here is a new capability — it is the platform's existing re-engagement loop, pointed at
teaching instead of at prompting. Which is why the prompt wording in §4 is the load-bearing part of
this change and the config is the easy part.

### 2.1 Why 3 seconds

Bounded on both sides:

- **Below ~2 s** the tutor starts talking over a learner who paused mid-sentence to find a word —
  which, for a B2–C1 speaker composing English aloud, is constant. `turn_eagerness: patient`
  (§4) buys some of this back, but not enough to go to 1 s.
- **Above ~4 s** the gap reads as expectation again, which is the whole complaint.
- It must also stay **≥ 3 s** for a mechanical reason that has nothing to do with pacing: §3.

3 s is the pick, and it is a guess with a range around it, not a measured optimum — P2 in §7.

## §3 The collision this change walks into `[code]`

**The held pause keeps a paused conversation quiet by resetting `turn_timeout` every 3 seconds.**

```ts
const HEARTBEAT_MS = 3_000;   // "3 s is three eighths of [the 7 s timeout], so a single lost
                              //  ping still lands inside the window (6 s < 7 s)"
```

Set `turn_timeout: 3` and that margin is **gone** — a 3-second heartbeat against a 3-second timeout
is a race, and the failure mode is the exact bug the learner reported two days ago: *the tutor
starts talking while the lesson is paused*, into a speaker that is silenced, running up the clock
and arriving back convinced it taught something. `types.ts` predicted this in writing:

> Pinned rather than inherited because a held pause depends on it … a platform default that moved
> would put the tutor back to talking into an empty room. `[code]`

It was right about the danger and wrong about the direction — the value that moves it is our own,
not the platform's.

**The fix is to make the coupling explicit instead of remembering it.** Both numbers move into
`packages/shared/src/tutor.ts` as one contract:

- `TUTOR_HEARTBEAT_MS = 1_000` — the mobile client's ping interval.
- `MIN_TURN_TIMEOUT_SECONDS = 3` — the floor every baked version must respect. Three times the
  heartbeat, not twice: at twice, one dropped ping already lands exactly on the timeout, which is a
  margin only on paper. At three times, a single loss still lands inside the window (2 s < 3 s), and
  two consecutive losses mean the line is in trouble — which the drop path handles, not a faster
  ping. The floor therefore equals what words-1.5 pins, so going lower means lowering the heartbeat
  first and redoing this arithmetic.
- `effectiveConfig()` **throws** when a version pins a timeout below the floor, so the violation is
  a failed `pnpm sync:agents` and not a pause that quietly stops working in production.

This is the right home for it under the repo's own test — *if this had a bug, could I fix it by
deploying the web app alone?* No: the heartbeat runs on the phone and the timeout is baked into an
ElevenLabs agent. It is precisely a thing both sides must agree on.

Cost of a 1 s heartbeat: one tiny data-channel message per second while paused, and only while
paused. Against the alternative — a silent, timing-dependent pause failure — it is not a trade worth
thinking about.

## §4 The build

### 4.1 Config, on words-1.5 only

| Field | Value | Why |
|---|---|---|
| `turnTimeoutSeconds` | **3** (was 7) | the inter-chunk gap — §2.1 |
| `turnEagerness` | **`patient`** | new baked field. *"waits longer"* before taking a turn `[docs]`, i.e. it is the endpointing knob, independent of the silence timer. With a 3 s timeout the tutor is quick to resume; `patient` is what stops it from resuming **over** a learner who is mid-thought. Untested pairing `[unverified]` |
| `maxTokens` | 220 (unchanged) | still the backstop, not the budget |
| `silenceEndCallTimeoutSeconds` | −1 (unchanged) | nothing may hang up a deliberately silent lesson |

Older versions are untouched: both new fields are omitted from the agent body when unset, so
words-1.0 … 1.4 keep the hashes already in the lockfile and sync leaves them alone.

### 4.2 Prompt, 1.4 → 1.5

Deleted — the four rules that manufacture the complaint:

- *"END EVERY TURN by handing the floor back with something short and answerable"*
- *"Then WAIT. Say nothing more until the learner answers."*
- SOUND's *"Then ask the learner to say it back."*
- the recap's *ask-and-wait* loop, and the per-item *"ready for the next one?"* check

Added — silence redefined, in the most prominent position in the prompt:

- **Never ask a question you expect an answer to.** No comprehension checks, no "say it back", no
  "shall I continue?".
- **Silence is normal and is not a signal.** When the learner says nothing, continue teaching from
  exactly where you were. Never ask if they are still there, never re-greet, never remark on a gap.
- **Optional asides are allowed and never waited on** — "want to go deeper on this one?" is fine
  *if you carry straight on as though you had not asked*.
- **The learner's way in is interruption**, and the existing interruption section (stop instantly,
  answer what they asked, stay short) is now the whole interaction model rather than one branch of
  it. After answering, return to narrating without asking permission.
- The recap becomes **ask → leave a beat → answer it yourself**, so recall still gets cued without
  the lesson stalling on a reply that is not coming.

The pause rule from 1.4 stays verbatim: told the learner paused, stop instantly and say nothing.

## §5 What this costs

- **The tutor will sometimes talk over the learner.** 3 s + `patient` is a guess. This is the
  headline risk and the one thing that would send the number back up.
- **Re-engagement wording is the prompt's job now, and prompts drift.** If the model starts filling
  gaps with "still with me?" the fix is prompt wording, not config — and it will show up in the
  transcript as a question, so it is measurable (§7 P3).
- **Less silence discount.** Agents bills conversation duration with a 95% discount on silences
  longer than 10 s `[docs]`; a 3 s gap never earns it, but neither did a 7 s one, so this is flat
  versus today. What does change: a learner who walks away **without pausing** now gets re-engaged
  every 3 s instead of every 7 s until `max_duration_seconds` (1800) stops it. The Pause button and
  that cap remain the only backstops.
- **Nothing here helps a learner who wants to be asked.** Podcast mode is a product choice, not a
  strictly better tutor; the version picker keeps words-1.4 one tap away for exactly that reason.

## §6 What was considered and rejected

- **`initial_wait_time`** — *"how long the agent will wait for the user to start the conversation if
  the first message is empty"* `[docs]`. We do send an empty `first_message`, but the kickoff user
  message fires immediately on connect `[code]`, so this timer never runs. Left unset.
- **`turn.mode`** — present on the live agent as `"turn"`, absent from the documented schema
  `[unverified]`. Undocumented and load-bearing: not something to flip on a guess.
- **`soft_timeout_config`** — the platform's own filler ("Hhmmmm...yeah.") while the model thinks,
  disabled at −1 on our agents. It fills *thinking* pauses, not *inter-chunk* pauses, so it is not
  the podcast mechanism. Worth a look separately if generation latency ever becomes the audible
  problem.
- **A `next_chunk` client tool driving continuation** (L4 of the previous document). It would make
  the tutor continue on the client's say-so rather than on a timer — strictly better control, and
  still the right long-term answer — but it is a second reconciled resource type in the sync script
  and does not need to block a change that is otherwise a prompt and two numbers.

## §7 Probes

| # | Probe | Answers |
|---|---|---|
| P1 | Run a full lesson on 1.5; count **question marks in agent turns** | did the questions actually stop? this is the complaint, stated as a number |
| P2 | Say nothing for two minutes | does it keep teaching, and does 3 s feel like flow or like being cut off? |
| P3 | Grep the transcript for "still there", "with me", "shall I" | is re-engagement continuing the lesson or prompting for a reply? |
| P4 | Interrupt mid-chunk, pause mid-sentence while asking | does `patient` stop the tutor from talking over a learner who hesitates? |
| P5 | **Pause a 1.5 lesson for two minutes**, watch the transcript | the §3 regression test: not one agent turn may appear while held |
| P6 | Compare turn lengths 1.4 vs 1.5 | dropping the hand-back must not let the monologue back in |

P5 is the one that must be run before this reaches a device the learner uses.

## §8 Built

- ✅ `TUTOR_HEARTBEAT_MS` / `MIN_TURN_TIMEOUT_SECONDS` in `packages/shared/src/tutor.ts`; mobile
  imports the heartbeat; `effectiveConfig()` throws below the floor
- ✅ `turnEagerness` on `PromptVersion` → `conversation_config.turn.turn_eagerness`, omitted when
  unset, covered by the sync hash
- ✅ `words-1.5.ts` — podcast prompt, `turn_timeout: 3`, `turn_eagerness: patient`
- ✅ synced — `agent_2401m0afx10ceqdsfxy8qgnfzmg8`, read back live as `turn_timeout: 3`,
  `turn_eagerness: patient`, `max_tokens: 220`; the version picker defaults to 1.5, 1.4 still selectable
- ⬜ every probe in §7
