# LiveKit: the tutor stops after one or two words and then says the lesson is done

Date: 2026-10-22. Reports `1ea56197`, `dd64d531`, `dbd66780`, `06389b51` (all `words-4.1`, all
2026-10-22) and `6ecb5858` (2026-10-08).

## 1. What the learner saw

- "It said all words were discussed, but we did only the first of them."
- "Why did you stop here?" / "Why did it stop talking?" / "No response after a while."
- The tutor saved the lesson's own words to the collection without being asked, heard "already
  present", and then closed the lesson.

## 2. The evidence: the turn ledger

The stored transcript is no help here: `sanitizeTranscript` cuts every line at 4,000 characters
(`MAX_TRANSCRIPT_LINE_CHARS`), so the transcripts end mid-word whether or not the audio did. The
worker's ledger (`livekit_turn_ledger`) records what Claude generated, what the framework believes
was heard, and when each turn started:

| conversation | first reply | at ~21 chars/s | next turn at | interrupted | errors |
|---|---|---|---|---|---|
| `38c7d389` | 9,817 chars, 3,377 tokens | ~7.5 min | 67 s (the tool call's follow-up) | no | none |
| `6538b35c` | 9,596 chars, 3,272 tokens | ~7.4 min | 57 s ("why did you stop here?") | no | none |
| `8141c92a` | 10,371 chars, 3,673 tokens | ~8 min | 48 s (the tool call's follow-up) | no | none |
| `f10644a5` | 11,745 chars, 4,049 tokens | ~9 min | 120 s ("Continue.") | no | none |

So:

1. On `words-4.1` the first reply is the **whole lesson**: all five items, a recap and a goodbye.
2. Its audio stops after 45–120 s, with no barge-in and no error. TTS errors do reach the ledger
   (`agent.ts`, the session `Error` handler), so the TTS stream ended *cleanly*.
3. Because the stream ended cleanly, the framework counts the whole text as heard
   (`agentHeardText === agentText`). The model's context says it taught all five words and said
   goodbye. Everything it does next follows from that: "I ran through all five words", "everything's
   in place for review".
4. In three of the four lessons the reply ends in an unasked `add_words_to_collection` call on the
   lesson's own items. The worker's tool description invited it ("or when they meet a word worth
   keeping"), and the `words-4.x` prompts do not carry `SAVE_TO_COLLECTION_CLAUSE`.

## 3. Why the audio stops: the most likely cause

In `qwen-tts.ts` the only clean way for a reply's stream to end before all its text is sent is the
server answering `task-finished` before we sent `finish-task`. That event was handled as success:
flush, close the stream, done. The text the pacer had not yet sent was dropped without a trace.

**Not proven.** The Qwen key lives only in the LiveKit Cloud secrets and `lk agent logs` was not
available, so the server-side reason (a task limit, an idle rule, something else) is unknown. The
change below makes the next case visible in the ledger either way.

## 4. What changed

- **`qwen-tts.ts`:** a `task-finished` we did not ask for is no longer the end of the reply. The rest
  of the text goes out on a new task (up to 20 times per reply), on a fresh socket. The worker log
  says `the server finished the task before finish-task at …`, and `onAnomaly("tts:early-finish")`
  puts it in the turn ledger's `errors`. `check.ts` runs this against a local server that ends the
  first task after one piece.
- **`save-words-tool.ts`:** the description now carries the clause's rules: save only on request,
  never the lesson's own items, and saving does not end the lesson. It is the only guard the
  `words-4.x` versions have.

## 5. What to check after the worker deploys

1. Run a `words-4.1` lesson for 3 minutes without speaking.
2. Query `livekit_turn_ledger` for the conversation. If `errors` contains `tts:early-finish`, §3 was
   the cause and the audio now continues. If the audio still stops and there is no such error, the
   cause is elsewhere (playout, the phone), and `lk agent logs` is the next step.

## 6. Not changed here

- **The whole-lesson first reply.** That is how `words-4.1`'s prompt is written. `words-4.2` (in the
  picker since 2026-10-10) asks for ~45 s chunks and carries on by itself with `autoContinue`, which
  also answers "it stopped talking and waited". It is the version to use; promoting it to the default
  is a separate decision.
- **The 23 s rule:** a tool call that stalls a reply's text for more than 23 s can still time out a
  Qwen task (docs/2026-10-09-qwen-tts-latency-and-rate-limits.md §5 A).
