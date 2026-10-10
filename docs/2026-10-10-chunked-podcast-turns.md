# Chunked podcast turns: a shorter opening, and the worker carries on between turns

Date: 2026-10-10. Version: `words-4.2` (`words-4.1` + chunking; first committed as `words-4.3`, renamed the same day when the Flash experiment that held the number `4.2` was removed). Follows
`2026-10-09-qwen-tts-latency-and-rate-limits.md`, which fixed the voice; this is about what the
tutor says and when it stops.

## 1. The problem, with numbers

First real lessons on `words-4.1` / `words-4.2` (worker logs, 2026-10-10):

| | |
|---|---|
| First turn | greeting + plan + a whole item: **911 and 962 output tokens** (≈ 450–500 words, ≈ 2.7–3 min of speech) |
| What the learner did | cut it off after **14–17 s** both times ("Move directly to comply") |
| Replies played to the end | 2 of 12; in the 4.2 lesson **0 of 4** |
| What that cost | ~95 % of what Claude wrote and Qwen synthesized was thrown away; the learner heard a 3-minute monologue they wanted to skip |

Measured again against the real model with the shared prompt (`PODCAST_LESSON_PROMPT`): turns of
**416–499 words (155–185 s)**, about five of them for the whole lesson (≈ 1,800–2,300 words).

The cause is the prompt, on purpose: "a whole thread, or a whole item, is a normal length for one
turn". That is right for ElevenLabs, OpenAI and Vapi, which re-engage a silent learner on their own
timer. The LiveKit worker has **no such timer** — after the tutor stops, nothing speaks until the
learner does — so a short turn would simply end the lesson. That is why "shorten the greeting" alone
is not an option: any shortening needs something that asks for the next part.

## 2. Design

Two halves that only work together, behind one new version so 4.0 / 4.1 / 4.2 stay controls.

### 2.1 The prompt (`podcast-lesson-chunked.ts`)

Built from `PODCAST_LESSON_PROMPT` by **exact replacement** of five passages (`replaceExact` throws at
import if one is gone), so a comparison against 4.1 varies pacing and nothing else:

1. the "keep your turns substantial" rule → each chunk is one thread, no recapping;
2. the greeting → greeting + plan + the *first thread* of the first item, then stop;
3. "teach one item at a time" → "…one thread per chunk";
4. a new **PACING** block (before "Handling interruptions"): chunks of ~100 words, four per item
   (meaning + translation, forms, usage, sound), "chunking splits the teaching, it does not shorten
   it", finish on a complete sentence and stop, treat the app's continue message like the empty turn,
   never mention chunks;
5. the ending → call `lesson_complete` after the wrap-up.

### 2.2 The worker (`auto-continue.ts`, `lesson-complete-tool.ts`, `agent.ts`)

`autoContinue` travels like `tts`: `PromptVersion.autoContinue` → token route → dispatch metadata →
worker. When on, an `AutoContinue` controller asks for the next chunk by `generateReply({ userInput:
CONTINUE_MESSAGE })` — a hidden user message in the established style of `KICKOFF_MESSAGE` and
`RESUME_MESSAGE` (added to `HIDDEN_KICKOFF_MESSAGES`, and skipped when the worker builds the stored
transcript).

| Event | Effect |
|---|---|
| A reply ends **naturally** (speech handle done, not `interrupted`) | after 400 ms, ask for the next chunk — if `agentState` is listening/idle and the learner is not speaking |
| A reply is **cut** (barge-in, phone `cancelTurn`) | nothing; the learner has the floor |
| Learner starts speaking | cancel the pending ask; reset the run counter |
| Phone **pause** (`PAUSE_CONTEXT` arrives) | hold: stop asking, and drop any reply already being written for a muted phone (`session.interrupt()`) |
| Phone **release** (`HELD_RESUME_PREFIX`) | carry on after 1.5 s — longer than a normal beat, so the phone's own resume message wins the race |
| Tutor calls **`lesson_complete`** | stop for good |
| 60 chunks in a row with no word from the learner | stop (backstop; a lesson is ~20) |

`lesson_complete` returns nothing on purpose: LiveKit runs a follow-up reply after a tool only when
the tool returned a value (`replyRequired: toolOutput !== undefined`), and a follow-up would be the
tutor talking after its goodbye.

A hard output cap of **640 tokens (≈ 300 words)** per request applies to chunked lessons only
(`ClaudeLLM.maxTokens`). It is a backstop, not the mechanism — see §3.

## 3. What was verified, and what was found

All against the real model (`claude-sonnet-5`) with the real `claude-llm.ts`, the real LiveKit
`AgentSession` in text mode (no audio, no phone), and the real controller.

| Check | Result |
|---|---|
| Opening turn | **140–170 words (≈ 50–60 s)** vs 416–499 (≈ 155–185 s) with the shared prompt — roughly a third |
| Later chunks | 135–245 words (≈ 50–90 s); the model overshoots its own "about 100 words" by ~2× and ignores tighter limits (a 100-word and a 130-word variant gave the same ~190 words/turn) |
| Does chunking shorten the lesson? | total teaching 1,050–2,130 words over 5–11 chunks across 9 samples vs ≈ 1,800–2,300 for the shared prompt — **somewhat shorter, with large run-to-run variance**; asking for a fixed four-chunk structure per item helped (11, 11, 7 chunks) but did not make it deterministic |
| Auto-continue in a real `AgentSession` | chunk → `speech done interrupted=false` → +0.4 s → next chunk, six times in a row; `lesson_complete` called once after the recap, **no speech after it** |
| Interrupt | `session.interrupt()` mid-chunk → `interrupted=true` → **no continue** for the 7 s the learner was "silent", then the learner's request was answered and chunking resumed |
| Tool semantics | exactly as read in the code: no follow-up reply after `lesson_complete` |
| A slip the cap exists for | after a learner skipped ahead, the tutor wrote the rest of the lesson — usage, sound, recap — as **one 732-word turn** and ended; with the 640-token cap the same scenario produced ordinary 160–170-word chunks |
| Unit | `check.ts`: 12 properties on the controller (continue / cut / cancelled / busy / held / release delay / complete / run cap) |

Also fixed on the way: `lk agent console --text` (Node's native TypeScript stripping) was broken by
constructor parameter properties in `qwen-tts.ts`; they are gone. The console itself needs a real TTY,
so it could not be run in the verification environment.

## 4. What was **not** verified

- **On a phone.** The first version of this design had a seam between chunks (the controller waited
  400 ms, then Claude's first token, then the first audio): **2.0–2.7 s** in a real-time simulation, and
  **11 s** in the first real lesson, where Claude took 10 s to start. §7.1 removes it; the simulation
  says 0.0 s, the phone has not confirmed.
- That the **pause context** is recognised end to end. The worker compares the incoming context note
  with `PAUSE_CONTEXT` and `HELD_RESUME_PREFIX`; a change to either wording in `packages/shared`
  changes it for both ends, but a phone build that predates a wording change would not hold.
- **Lesson depth.** Chunked lessons may be 10–40 % shorter than 4.1's. Whether that is better or worse
  is a listening question.

## 5. How to evaluate 4.2 against 4.1

Run the same lesson on both, then in `lk agent logs`:

- **Opening length**: the first `[ledger] #0 … out=` — 4.1 ≈ 900, 4.2 expected ≈ 300.
- **Interrupted opening**: how often the learner cuts the first turn, and `out=` of interrupted replies
  (4.1: 900+ wasted tokens; 4.2: a few hundred).
- **Gaps**: from `[qwen stream …] done` of one chunk to `start` of the next, and the `[auto-continue]`
  lines (`stopped…`, `held…`, `released…`, `lesson_complete`).
- **Depth**: how many chunks a lesson takes, and whether the recap and `lesson_complete` arrive.
- **By ear**: does the seam between chunks sound like a podcast or like a series of clips?

## 6. Options still open

| Option | Why |
|---|---|
| Pre-generate the next chunk while the current one plays | removes the 2–3 s seam; costs tokens when the learner interrupts (they are cheap now) |
| Stricter chunk length | the model ignores word budgets; a smaller `CHUNK_MAX_TOKENS` (≈ 450) would force ~200 words but cuts mid-sentence on the longer chunks |
| Server-side thread plan | the worker (or web route) could name the thread for each continue ("USAGE of item 2") instead of letting the model choose; deterministic depth, more machinery |
| Offer the LiveKit versions in the picker | check `CLIENT_READY` in `agent-registry.ts` first |

## 7. Follow-ups, same day (2026-10-10)

### 7.1 Pre-generate the next chunk (no more seam)

LiveKit's `generateReply` does not interrupt what is speaking: it creates a speech handle, **starts the
model and the voice at once**, and plays the result when the handle's turn comes (read in
`agent_activity.js`: `performLLMInference`/`performTTSInference` run before the wait for
authorization; the request copies the conversation at call time). So the controller now queues the
next chunk **the moment a turn's text has been written** — 40 s before it is due — instead of a beat
after the previous one ends (`AutoContinue.turnWritten`, `auto-continue.ts`).

The one non-obvious part: the chunk still playing is not in the conversation yet (it joins it when
played out), so the queued request is handed a context that includes it
(`auto-continue-wiring.ts`). The rules for *not* queuing, and for cancelling what was queued, are in
the controller's header; the ones that matter most are: the learner speaking drops it, the phone's
pause drops it, a turn that ended in a tool call is not queued past, and `lesson_complete` drops the
chunks **behind** the goodbye but spares the goodbye itself (a first version cut it — found by running
a lesson to its end in text mode).

Measured with a speaker that takes real time to play (real Qwen voice, real model, the production
wiring), two runs each:

| | gaps between chunks |
|---|---|
| fallback only (previous behaviour) | 2.6, 2.0, 2.4 s · 2.6, 2.7, 2.5, 2.5 s |
| pre-generation | **0.0, 0.0, 0.0, 0.0 s · 0.0, 0.0, 0.0, 0.0, 0.0 s** |

Chunk sizes were the same in both modes (85–123 words) once the first run's two outliers (210 and 315
words, one sample) were not reproduced. The cost is a chunk's worth of model output (~150 tokens)
whenever the learner interrupts, which they often do; it is dropped unspoken. The fallback timer
remains for the cases where nothing was queued.

### 7.2 The lesson ends properly

`lesson_complete` used to stop the controller and leave the phone connected to a tutor that would
never speak again. Now the tool waits for the goodbye to finish playing (`RunContext.waitForPlayout`),
and if the learner did not talk over it the worker ends the session after 1.5 s: the existing shutdown
callback sends `tutor.ending`, which the phone already turns into `onEnd("agent")` and the "ended"
state, and posts the session. Verified in text mode: `onComplete` → `onFinished` in the same turn, the
goodbye not interrupted. The audio-length wait is LiveKit's own; it was not exercised with audio.

### 7.3 Claude Sonnet 5.5

The LiveKit versions (`words-4.0`, inherited by 4.1 and 4.2) and the worker default now use
`claude-sonnet-5-5`. One change was needed: the 5.5 family **rejects `thinking: {type: "disabled"}`**
(400: "send `between_tools` instead"). `thinkingFor(model)` in `claude-request.ts` picks the spelling;
under `between_tools` the model writes short updates between tool calls as `thinking` blocks, which the
stream loop does not read (it takes `text_delta` and `tool_use` only), so they are never spoken. A tool
round trip whose follow-up request omits the thinking block — what `buildAnthropicMessages` sends — was
probed and accepted. With 5.5 the chunks came out shorter and closer to their budget (87–123 words,
against 135–245 on Sonnet 5), and the lesson still ran to `lesson_complete`.

### 7.4 Considered and not done

- **Word-level transcript timing.** The phone takes only final transcription segments from LiveKit
  (`apps/mobile/src/lib/transport/livekit.ts`) and highlights no words, so there is nothing to feed.
- **A server-side thread plan** (name the thread in each continue message). A tester judged the depth of
  the chunked lesson fine, and a fixed plan would fight the learner's jumps ("skip to comply"). It stays
  an option if depth varies in practice.

### 7.5 Housekeeping

Versions after this change: `words-4.0` (Deepgram), `words-4.1` (Qwen Plus), `words-4.2` (Qwen Plus,
chunked). The Flash version and profile are gone, the "(spike)" is gone from the labels, and `4.3` was
renamed `4.2`. Sessions stored under the old names are the retired experiments, not today's versions.
