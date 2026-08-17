# Short turns and a chunked pause — why Pause feels late and Resume repeats

**Date:** 2026-08-17
**Scope:** the voice lesson on mobile (`apps/mobile/src/app/lessons/[id]/index.tsx`), the tutor wire
contract (`packages/shared/src/tutor.ts`), and the agent registry (`apps/web/src/agent/prompts/`,
`apps/web/src/agent/sync-agents.ts`). Research only — nothing here is built.
**Status:** **P1 and P2 built 2026-08-17** — `words-1.4` (agent `agent_6301m08130prfqfsantvjnbgqtsj`,
`max_tokens: 220` verified live), the `PAUSE_STOP_MESSAGE` barge-in, and the two bounded resume
messages. **Unmeasured: every number in §1.1 and §2 is still arithmetic — P1/P2 of §7 need a real
device.** Not built: **L4** (the `next_chunk` client tool, §3) and everything downstream of it,
i.e. §8 P3–P4. Research otherwise; it supersedes nothing and sits **on top of**
`docs/2026-08-16-tutor-pause-hold-the-line.md`, whose mechanism (mute + heartbeat, line held open)
stays exactly as it is. The claim of this document is that the remaining complaint is not a pause
bug at all.
Claims are tagged `[source]` (read out of the pinned SDK in `node_modules`), `[docs]` (ElevenLabs
documentation, fetched 2026-08-17), `[code]` (this repo), `[unverified]` (needs a probe from §7).

---

## The ask

> for now we have too long transcriptions
> and even when I click Pause agent continue talking (in background) and after Resume — repeats the
> same big chunk of data
> Provide research how we can have these talks shorter, split huge conversation to small chunks and
> Pause/resume on these small chunks

## The headline

**Pause can never be finer-grained than one agent turn, because the client cannot abort a turn.**
The ElevenLabs client→server protocol has exactly eight events and none of them is "stop talking"
`[source]` — so when Pause lands mid-monologue, the monologue plays out to a silenced speaker, the
transcript records all of it, and Resume then asks for a recap of *all of it*. Every part of the
reported symptom follows from the size of one turn.

So the fix is not in the pause machine. It is in three places, in this order:

1. **Make a turn small.** The prompt currently defines one turn as *one whole item, five threads
   deep* — meaning, translation, forms, usage, sound — which is a 60–120 second monologue. Six
   sentences is a turn. A whole item is a chapter. `[code]`
2. **Abort what is in flight.** `user_message` *"triggers the same response flow as spoken user
   input"* `[docs]` — i.e. it barges in. A hidden stop token on Pause cuts the turn where the
   learner stopped hearing it, and `onAgentResponseCorrection` hands back the truncated text
   `[source]`, so the record finally matches what was heard.
3. **Restate the chunk, not the chapter.** Resume today sends `SOFT_RESUME_MESSAGE` — *"Recap that
   briefly, then carry on"* — with no bound on what "that" is. Once a chunk is ~6 sentences, "that"
   is small, and once the client knows the chunk index it can name it. `[code]`

The optional fourth step, and the one that answers "split the conversation into small chunks" as a
*protocol* rather than as prompt wording, is a **chunk-boundary client tool**: the tutor calls
`next_chunk` between chunks, and the client answers `"continue"` or `"pause"`. That converts pause
from something we do *to* a conversation into something the conversation *asks about* — and it
hands the app real lesson state (which item, which thread) for free, which is what §6 of the
hold-the-line document wanted and could not get from a chat log.

---

## §1 Diagnosis — where the "big chunk" is made

### 1.1 The prompt defines the turn as a whole item `[code]`

`apps/web/src/agent/prompts/words-1.3.ts` instructs, for **each** item:

> weave these threads into a natural spoken explanation … MEANING … TRANSLATION … FORMS … USAGE …
> SOUND

with FORMS alone asking the tutor to *"walk the whole word family aloud, naming each member's part
of speech"* and USAGE asking for *"2–3 natural example sentences"* plus collocations plus traps.
That is five threads and roughly ten obligations in one breath.

Two bullets further down the same prompt says:

> Keep each turn short (a few sentences) and pause often, so the learner can interrupt you at any
> moment.

These instructions are in direct conflict, and the specific one wins: a model asked for five named
threads about one word produces all five. **"A few sentences" is not a budget — it is a wish.** A
budget is a number, stated where the work is described, plus a mechanism that ends the turn.

Rough arithmetic for the size of the problem: conversational TTS runs ~150 wpm ≈ 2.5 words/s. Five
threads at 40–60 words each is 200–300 words ≈ **80–120 seconds of unbroken speech per item.** That
is the "big chunk" in the ask, and it is also the pause latency, the repeat size, and the amount of
lesson a learner has to sit through to reach the next place they may speak.

### 1.2 Nothing can abort a turn from the client `[source]`

`BaseConversation.js` in the pinned `@elevenlabs/client` sends exactly these message types:

| Event | Method | Effect |
|---|---|---|
| `pong` | (internal) | keepalive |
| `feedback` | `sendFeedback` | thumbs up/down |
| `contextual_update` | `sendContextualUpdate` | background info, **does not interrupt** `[docs]` |
| `user_message` | `sendUserMessage` | *"same response flow as spoken user input"* `[docs]` |
| `user_activity` | `sendUserActivity` | *"resets the turn timeout timer"*, no content effect `[docs]` |
| `client_tool_result` | (tool plumbing) | answers a `client_tool_call` |
| `mcp_tool_approval_result` | `sendMCPToolApprovalResult` | MCP approval |
| `user_audio_chunk` | mic | speech |

There is no `stop`, no `abort`, no `flush`. `interruption` exists but is **server→client** — a
notification that the agent *was* interrupted, not a request to interrupt it `[source]`. The only
two levers that end a turn early are therefore **real speech** (VAD barge-in — unavailable, because
Pause mutes the microphone) and **`user_message`** (§3, L5).

This is exactly what `holdSession` already documents: *"The agent may still be finishing a sentence
into the void."* `[code]` The design was right; it just assumed the sentence was a sentence.

### 1.3 Resume asks for an unbounded recap `[code]`

```ts
const unheard = linesRef.current.slice(heldAtLineRef.current).some((l) => l.role === "agent");
if (unheard) sendUserMessage(SOFT_RESUME_MESSAGE);
```

and

```
SOFT_RESUME_MESSAGE = "I'm back — I didn't hear what you said while I was away.
                       Recap that briefly, then carry on."
```

Two problems, both invisible while turns are short:

- **"that" is the whole monologue.** The tutor's own context contains a 250-word explanation it
  believes was delivered, and it is being asked to recap it. "Briefly" is again a wish, not a bound.
- **The tutor believes the learner heard it.** Local gain is set to 0 through LiveKit
  (`setAgentAudioVolume`); the server has no idea. So the agent's context says *taught*, the
  learner's ears say *nothing*, and the recap is the app trying to reconcile those two with an
  adverb.

### 1.4 The compound

| What the learner does | What actually happens | Why |
|---|---|---|
| taps Pause 10 s into an item | silence is instant, but 70–110 s of teaching still streams into the transcript and into the agent's context | §1.2 — no abort |
| taps Resume | `SOFT_RESUME_MESSAGE` fires because ≥1 agent line landed while held | §1.3 |
| listens | the tutor re-delivers the whole item, because that is what it thinks it just taught | §1.1 + §1.3 |

Reported as "Pause doesn't work". Actually: **pause works, the unit is wrong.**

---

## §2 Measure before tuning

Everything above is arithmetic on a prompt. The real distribution is already stored — one row per
conversation in `lesson_sessions.transcript` (`[{role, text}]`) `[code]`. Before changing anything,
get the number:

```sql
-- agent turn length distribution, in characters (≈ chars/15 = seconds of speech)
select
  count(*)                                              as agent_turns,
  percentile_cont(0.50) within group (order by len)     as p50_chars,
  percentile_cont(0.90) within group (order by len)     as p90_chars,
  max(len)                                              as max_chars
from (
  select length(t->>'text') as len
  from lesson_sessions s, lateral jsonb_array_elements(s.transcript) t
  where t->>'role' = 'agent'
) x;
```

Targets to design against, and to re-measure after each phase:

| Metric | Today `[unverified]` | Target |
|---|---|---|
| p50 agent turn | expect 600–1200 chars | **≤ 350 chars** (~25 s) |
| p90 agent turn | expect 1500+ | **≤ 600 chars** (~40 s) |
| learner turns per item | expect ~1 | **≥ 3** |
| pause→silence-for-the-agent | ∞ (never; turn plays out) | **≤ 1 chunk**, ideally < 2 s with L5 |

The learner-turns-per-item number is the one that matters pedagogically: it is the difference
between a podcast and a lesson.

---

## §3 The levers

Ranked by effort-to-effect. L1+L2 are a prompt version and a config field — a day. L4+L5 are the
architecture the ask actually describes.

### L1 — Redefine the turn in the prompt `[code]` · cheap · biggest single win

Three edits to `words-1.3` → `words-1.4`:

1. **One thread per turn, not five.** Split the item into an explicit sequence of chunks and forbid
   running them together:
   *"Teach one THREAD at a time and then stop. A thread is MEANING, or TRANSLATION, or FORMS, or
   USAGE, or SOUND — never two in one turn."*
2. **Give the budget a number, at the point of work.** *"Each turn is at most **four sentences**,
   about 60 words. When you reach the end of a thread, stop speaking and hand the floor back."*
   Numbers survive; "a few" does not.
3. **Make handing back the floor concrete.** End each chunk with a short, answerable move — a check
   ("say it back to me"), a choice ("more examples, or the forms?"), a micro-question. A turn that
   ends in a question ends; a turn that ends in a statement invites the model to keep going.

Also delete the conflicting *"Keep each turn short (a few sentences)"* bullet — a prompt that says
both things teaches the model that neither is binding.

Cost: none. Risk: models drift back to monologue over a long session — which is why L2 exists.

### L2 — `max_tokens` as the mechanical backstop `[docs]` · cheap

`conversation_config.agent.prompt.max_tokens` — *"If greater than 0, maximum number of tokens the
LLM can predict"*, **default `-1`** (unlimited), which is what we run today `[docs]` + `[code]`.

At ~1.4 tokens/word, a 60-word turn is ~85 tokens; **120–150** leaves headroom for a long example
without permitting a chapter. This is a *backstop*, not the primary control: hitting the cap
truncates mid-sentence, which TTS will happily speak. So set it above the prompt's own budget, wire
it through `PromptVersion` next to `turnTimeoutSeconds`, and treat "we hit the cap" as a prompt bug.

Add to `PromptVersion` (`apps/web/src/agent/prompts/types.ts`) and to `agentBody`
(`sync-agents.ts`), which today sends `prompt: { prompt, llm }` and nothing else `[code]`.

### L3 — Turn-taking config `[docs]` · cheap · secondary

Fields we have never set, all under `conversation_config.turn`:

| Field | Default | Relevance |
|---|---|---|
| `turn_eagerness` | `normal` (`patient` / `eager`) | `patient` gives a learner formulating English in their second language time to start; `eager` makes short chunks feel snappy. These pull opposite ways — **do not tune this until L1 has landed**, or you will be tuning cadence against a monologue. |
| `turn_model` | `turn_v3` | pinned by default already; note it for determinism the way `turn_timeout` is pinned |
| `speculative_turn` | `false` per the docs, but **`true` on our live agents** — read back from the API 2026-08-17, so the documented default is stale `[docs]` + `[unverified]` | *"starts generating LLM responses during silence"* — short chunks mean more turn boundaries, so more inter-chunk latency; this is the direct mitigation. Costs extra LLM generations that get thrown away. |
| `initial_wait_time` | — | how long before the agent speaks first |

`turn_timeout` (7 s) and `silence_end_call_timeout` (−1) stay exactly where they are: the held pause
depends on both, as `types.ts` already documents `[code]`.

### L4 — A chunk-boundary client tool `[docs]` + `[source]` · the "split into chunks" answer

The SDK supports client tools on the React Native path: `BaseConversation.handleClientToolCall`
dispatches `client_tool_call` → the handler → `client_tool_result` `[source]`, the WebRTC connection
routes data-channel events into the same handler `[source]`, and `@elevenlabs/react` exposes both
`clientTools` on the provider and a `useConversationClientTool(name, handler)` hook `[source]`.
Agent-side, a client tool is created through the Tools API and referenced from
`conversation_config.agent.prompt.tool_ids` `[docs]`.

The tool config fields that matter `[docs]`:

| Field | Default | Why it matters here |
|---|---|---|
| `expects_response` | `false` | **`true` blocks the conversation until the client responds** — this is the whole mechanism |
| `response_timeout_secs` | `20` (range 1–120) | the longest a chunk boundary can be held open before the platform gives up |

The contract:

```
tutor teaches chunk k  →  calls next_chunk({ item, thread, taught })  →  client answers
        ↑                                                                    │
        └──────────────── "continue" ────────────────────────────────────────┘
                          "pause"     → tutor says nothing; heartbeat holds the line
```

What this buys, beyond shorter turns:

- **Pause lands at a boundary, by construction.** No abort needed for the common case: the learner's
  tap is recorded, and the very next `next_chunk` call returns `"pause"`. Worst case, the learner
  hears the rest of one ≤4-sentence chunk — which is *smaller than the reaction time of a person
  reaching for their phone*.
- **Resume has an address, not a chat log.** The client knows `{item, thread, k}`. Resume becomes
  "continue from item 3, USAGE" — a sentence with a referent — instead of "recap that".
- **The app finally has lesson state.** Which items are taught, which thread is live, how far in. §6
  of the hold-the-line document asked for exactly this so the *parked* fallback (force-quit, crash,
  30-minute cap) could stop repeating too. A chat log cannot answer "which item was in progress"; a
  tool call is that answer.
- **It is a progress bar.** `activityWords` on the lock-screen card can show the item being taught
  rather than the whole list.

Costs and risks, honestly:

- **Every boundary is a round trip.** Tool call → client → result → next generation. Budget
  200–500 ms of extra dead air per chunk `[unverified]`, partially recoverable with
  `speculative_turn`.
- **A new resource type in the sync script.** `sync-agents.ts` reconciles agents only; client tools
  live in the Tools API and are referenced by id, so the lockfile and the hash-diff logic grow a
  second dimension. This is the real engineering cost of L4 and the reason it is phase 2, not
  phase 0.
- **Models skip tools they find pointless.** A tool whose description does not make the call
  *necessary* gets dropped after a few turns. The description has to state that the tutor may not
  continue without it. Mitigation if it drifts: `expects_response: true` plus a prompt rule, and
  measure the call rate per chunk in the transcript.
- **`response_timeout_secs` ≤ 120 s means a held tool call is not a pause implementation.** Answer
  the tool immediately with `"pause"`; keep holding the line with the existing heartbeat. Do not try
  to park the conversation inside an unanswered tool call.

### L5 — Abort the in-flight turn with a hidden stop token `[docs]` · small · fixes the remaining gap

`user_message` *"is processed as user input … Triggers the same response flow as spoken user
input"* `[docs]` — so it barges in the way speech does. Pause can therefore stop the turn that is
already streaming:

```ts
// in holdSession(), only when mode === "speaking"
setAgentAudioVolume(rawConversation, 0);   // ears first, as today
setMuted(true);
sendUserMessage(PAUSE_STOP_MESSAGE);       // barge-in: ends the turn server-side
sendContextualUpdate(PAUSE_CONTEXT);       // why, non-interrupting
heartbeat…
```

`mode`/`isSpeaking` is already on the hook (`useConversation().mode: "speaking" | "listening"`)
`[source]`, so this fires only when there is something to abort.

Two consequences, both good:

- **`onAgentResponseCorrection` fires on barge-in and carries `corrected_agent_response`**
  `[source]` — the truncated text. The screen already handles this callback and rewrites the stored
  line `[code]`. So after the abort, **the transcript says what the learner actually heard**, which
  is the thing that has been false since the held pause shipped. Resume can then be honest: the
  unheard remainder is a known quantity, not a guess.
- The stop token must be added to `HIDDEN_KICKOFF_MESSAGES` so it never reaches the visible
  transcript or the stored history — the array exists for exactly this and the post-call webhook
  filters on it `[code]`.

The risk, and it is the whole reason this is `[unverified]`: **a barge-in provokes a reply.** The
agent may answer the stop token with a short line before the heartbeat settles it. Mitigations, in
order of preference: word the token as an instruction not to respond (`"[system] The learner just
paused. Stop speaking immediately and say nothing."`); back it with a prompt rule in words-1.4; and
accept that one short line is a strictly smaller failure than 90 seconds of unheard monologue. §7
P2 measures it.

### L6 — Agent Workflows / subagent nodes `[docs]` · heavy · not now

ElevenLabs Workflows model a conversation as a graph: **subagent nodes** (own prompt, LLM, tools,
voice, knowledge base), **tool nodes** (a guaranteed tool call as a step), transfer nodes, end
nodes, with LLM-condition and unconditional edges `[docs]`. "One node per thread" is a tempting
literal reading of "split the conversation into chunks".

Reasons to keep it on the shelf:

- The workflow is authored in a **visual editor**, which fights the repo's rule that the filesystem
  is the source of truth and `pnpm sync:agents` reconciles from it `[code]`.
- Whether conversational context survives node transitions is **not documented** `[docs]` — and
  "the agent keeps its own context" is the entire load-bearing property of the held pause.
- A five-node-per-item graph is a lot of machinery to express "stop after four sentences", which L1
  expresses in one sentence.

Revisit if the lesson ever needs genuinely different *modes* (teach → drill → recap) with different
tools and voices. That is what nodes are for. Chunking is not.

---

## §4 The recommended design

### 4.1 The chunk contract

A **chunk** is one thread of one item: ≤ 4 sentences, ~60 words, ending in a move that hands the
floor back. An **item** is 3–5 chunks. A **lesson** is items × chunks. The learner may speak at every
boundary, which is the pedagogical point independent of pause.

### 4.2 Pause, as a state machine

```
                    tap Pause
  connected ─────────────────────────────► holding
      ▲            1. gain → 0 (ears)                │
      │            2. mic → muted                    │
      │            3. if speaking: stop token  (L5)  │
      │            4. pauseRequested = true    (L4)  │  next_chunk → "pause"
      │            5. contextual update: why         │
      │            6. heartbeat every 3 s            │
      │                                              │
      └────────────── tap Resume ────────────────────┘
                 1. heartbeat off
                 2. mic → learner's own pre-pause state
                 3. gain → 1
                 4. contextual update: gap length
                 5. restate EXACTLY the aborted chunk, or nothing
```

Steps 1, 2, 5, 6 and the mute-restore are already built and stay verbatim `[code]`. Step 3 is L5,
step 4 is L4, and step 5 of Resume is the rewrite below.

### 4.3 Resume, addressed

Replace the unbounded `SOFT_RESUME_MESSAGE` with three cases, decided by state the client already
holds:

| At pause the tutor was… | What the learner missed | Resume sends |
|---|---|---|
| listening | nothing | **nothing** — the learner speaks first (today's behaviour, and correct) |
| speaking, aborted cleanly (L5) | the tail of one chunk | *"Finish that thought — the last few seconds didn't reach me. Nothing else."* |
| speaking, not aborted (no L5, or a chunk slipped past) | ≤ 1 chunk | *"Repeat just your last point about `{item}` — one or two sentences — then carry on."* |

Every one of these is bounded by *a chunk*, which is the difference from today. And with L4 the
`{item}`/`{thread}` in that string are real values, not a hopeful pronoun.

`formatHeldResumeContext(pausedSeconds)` stays as-is: stating the gap so the tutor can pitch its own
re-entry is right and cheap `[code]`.

### 4.4 Symptom → fix

| Symptom (verbatim) | Cause | Fixed by |
|---|---|---|
| "too long transcriptions" | prompt defines a turn as a whole item | **L1**, backstopped by **L2** |
| "agent continue talking (in background)" | no client-side abort; turn plays into a silenced speaker | **L5** (abort now) + **L1/L4** (make what is left tiny) |
| "after Resume repeats the same big chunk" | `SOFT_RESUME_MESSAGE` recaps an unbounded "that" | **§4.3** (bounded, addressed restatement) |
| "split huge conversation to small chunks" | there is no chunk concept anywhere in the system | **L1** (in speech) + **L4** (as protocol + state) |

---

## §5 The facts this rests on

| # | Fact | Tag |
|---|---|---|
| F1 | The client can send exactly: `pong`, `feedback`, `contextual_update`, `user_message`, `user_activity`, `client_tool_result`, `mcp_tool_approval_result`, `user_audio_chunk`. **No abort/stop event exists.** | `[source]` |
| F2 | `user_message` — *"processed as user input … Triggers the same response flow as spoken user input"* → it barges in | `[docs]` |
| F3 | `contextual_update` — *"incorporated as background information … Does not interrupt the current conversation flow"* | `[docs]` |
| F4 | `user_activity` — *"Resets the turn timeout timer. Does not affect conversation content or flow"* | `[docs]` |
| F5 | `conversation_config.agent.prompt.max_tokens`, integer, **default −1** (unlimited) — *"If greater than 0, maximum number of tokens the LLM can predict"* | `[docs]` |
| F6 | `conversation_config.turn.turn_eagerness` ∈ {`patient`,`normal`,`eager`}, default `normal`; `turn_model` default `turn_v3`; `speculative_turn` default `false` — *"starts generating LLM responses during silence"* | `[docs]` |
| F7 | Client tool `expects_response` (default `false`) — *"If true, calling this tool should block the conversation until the client responds"*; `response_timeout_secs` default **20**, range **1–120** | `[docs]` |
| F8 | Client tools are created via the Tools API and attached through `conversation_config.agent.prompt.tool_ids` | `[docs]` |
| F9 | The RN SDK dispatches `client_tool_call` → handler → `client_tool_result`, and `@elevenlabs/react` exposes `clientTools` + `useConversationClientTool(name, handler)`; WebRTC delivers events over `RoomEvent.DataReceived` into the same path | `[source]` |
| F10 | `onAgentResponseCorrection({ original_agent_response, corrected_agent_response })` fires on barge-in; the mobile screen already rewrites the stored line from it | `[source]` + `[code]` |
| F11 | `useConversation()` exposes `mode: "speaking" \| "listening"` and `isSpeaking` | `[source]` |
| F12 | `agent_response_complete` — *"fires exactly once when an agent's response is fully delivered"* — is documented but **absent from the pinned SDK's callbacks** (`@elevenlabs/react-native` 1.2.18); `onModeChange` is today's turn-boundary signal | `[docs]` + `[source]` |
| F13 | `agentBody()` sends `prompt: { prompt, llm }` — no `temperature`, no `max_tokens`, no `tool_ids`; adding any of them is a `PromptVersion` field plus a hash-diff PATCH | `[code]` |

---

## §6 What this costs

- **More turns = more LLM calls.** Five short generations per item instead of one long one. Token
  cost is roughly flat (same words), but per-call overhead and latency are not. `speculative_turn`
  and short prompts mitigate; measure P3.
- **Dead air at boundaries.** The lesson gains 3–5 gaps per item. Some of that is *desirable* — it
  is where the learner speaks — but a 700 ms silence after every four sentences reads as a laggy
  app, not as a patient teacher. This is the metric most likely to send L4 back to the drawing
  board.
- **Prosody.** `eleven_v3_conversational` shapes intonation over the turn; chopping turns can make
  the tutor sound clipped. Worth one listen before/after, not a blocker.
- **Sync-script complexity.** L2 is one field. L4 is a second reconciled resource type with its own
  lockfile entries. Do not conflate the two in one PR.
- **Nothing here helps a `parked` pause.** Force-quit still lands in the reconnect-and-replay path
  that `docs/2026-08-16-tutor-pause-hold-the-line.md` §1 shows to be structurally lossy — until L4's
  lesson state is carried into the resumed conversation instead of a chat-log tail. That is the
  phase-3 prize and the reason L4 is worth its cost.

---

## §7 Probes

Each is a device run of one lesson with ≥ 5 items, transcript read afterwards.

| # | Probe | Answers |
|---|---|---|
| P1 | Run the §2 query on today's stored sessions | the real turn-length distribution — the baseline every claim in §1.1 is currently estimating |
| P2 | With words-1.4 (L1) only: pause mid-item, resume, read the transcript | did turn length drop? is the leftover monologue now ≤ 1 chunk? |
| P3 | Send `PAUSE_STOP_MESSAGE` on pause (L5): does audio stop within ~1 s, does `onAgentResponseCorrection` fire, does the agent reply to the token? | whether L5 is a clean abort or trades one problem for a smaller one |
| P4 | Set `max_tokens: 150` (L2) and run a full lesson | how often the cap is hit — a cap that fires often means L1 failed, and mid-sentence truncation is audible |
| P5 | Time the gap between chunks with a `next_chunk` tool registered (L4) | the real boundary latency, with and without `speculative_turn` |
| P6 | Long pause (10 min) with L4 in place: does `next_chunk` get re-called during the hold? | whether the heartbeat and a pending tool boundary interact badly |

P1 and P2 are worth running before anything is built; they are the difference between "the prompt is
too long" as an argument and as a measurement.

---

## §8 Phasing

| Phase | Content | Ships |
|---|---|---|
| **P0** | §2 measurement | **not run** — the baseline is still owed |
| **P1** | ✅ **built** — **L1** `words-1.4` (one thread per turn, four-sentence budget, explicit hand-back, the conflicting bullet deleted, plus a "when the learner pauses" rule); **§4.3** resume rewrite as `ABORTED_RESUME_MESSAGE` / `UNHEARD_RESUME_MESSAGE` | `apps/web/src/agent/prompts/words-1.4.ts`, `packages/shared/src/tutor.ts` |
| **P2** | ✅ **built** — **L5** `PAUSE_STOP_MESSAGE` on pause, guarded on `isSpeaking`, hidden from the transcript; **L2** `maxTokens` on `PromptVersion` → `prompt.max_tokens`, omitted when unset so words-1.0…1.3 keep their lockfile hashes | mobile screen + shared + `sync-agents.ts` |
| **P3** | *next* — **L4** — `next_chunk` client tool, Tools API in the sync script and the lockfile, chunk state in the screen, pause-at-boundary, addressed resume | the architecture piece |
| **P4** | Carry P3's lesson state into the **parked** resume, retiring the chat-log tail (`formatResumeContext`) as the primary hand-over | closes hold-the-line §6 |

P1 alone should make the reported symptom mostly disappear, because every part of it scales with
turn length. P2 makes pause instant. P3 makes it exact — and is the only phase that pays for itself
twice, since it is also what a non-repeating parked resume needs.

## §9 Open questions

1. **Does the stop token provoke a reply?** (P3.) If it reliably does, L5 becomes "abort and accept
   one short line", which is still a win, but the prompt has to own it.
2. **Does the model keep calling `next_chunk` after 20 minutes?** Tool-call drift over a long
   session is the standard failure of this pattern and the reason `expects_response: true` matters.
3. **Is a 4-sentence chunk the right size for a B2–C1 learner**, or does teaching fragment? This is a
   pedagogy question, not an engineering one — P2's recording is the only way to answer it.
4. **Should the pause boundary be a chunk or an item?** A chunk is more responsive; an item is a
   more natural place to stop and come back to. Possibly: abort at the chunk, but resume by naming
   the item.
