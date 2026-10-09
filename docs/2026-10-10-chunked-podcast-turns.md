# Chunked podcast turns: a shorter opening, and the worker carries on between turns

Date: 2026-10-10. Version: `words-4.3` (`words-4.1` + chunking). Follows
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

- **On a phone.** Nothing here has run in a real lesson. In particular the gap between chunks: the
  controller waits 400 ms, then Claude's first token (0.7–1.5 s) and the first audio (≈ 0.9 s warm) —
  expect **2–3 s of silence between chunks**, against none inside a long turn. If it is noticeable the
  fix is to start generating the next chunk before the current one finishes playing.
- That the **pause context** is recognised end to end. The worker compares the incoming context note
  with `PAUSE_CONTEXT` and `HELD_RESUME_PREFIX`; a change to either wording in `packages/shared`
  changes it for both ends, but a phone build that predates a wording change would not hold.
- **Lesson depth.** Chunked lessons may be 10–40 % shorter than 4.1's. Whether that is better or worse
  is a listening question.

## 5. How to evaluate 4.3 against 4.1

Run the same lesson on both, then in `lk agent logs`:

- **Opening length**: the first `[ledger] #0 … out=` — 4.1 ≈ 900, 4.3 expected ≈ 300.
- **Interrupted opening**: how often the learner cuts the first turn, and `out=` of interrupted replies
  (4.1: 900+ wasted tokens; 4.3: a few hundred).
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
| Offer 4.3 in the picker | still withheld by `CLIENT_READY`, like 4.0–4.2 |
