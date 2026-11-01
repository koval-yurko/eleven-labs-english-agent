# Tutor speech: no pauses between sentences, no emphasis (words-4.5)

Research for learner report `152bb06c` (livekit, words-4.5, 2026-10-31): "There is no pause between
sentences or paragraphs. One flow without emphasizing."

## 1. What happened

The tutor opened with 1 reply of about 50 s: 8 paragraphs, about 60 sentences (transcript in
`pnpm report 152bb06c`). Claude wrote the paragraphs with `\n\n`. The learner heard 1 flat stream.

## 2. The path of the text (words-4.5)

words-4.5 speaks with the TTS profile `voicebox-local-woman-2`
(`services/voice-worker/src/tts-profiles.ts`): Voicebox over `WS /tts/ws`, engine `qwen`, model
`Qwen/Qwen3-TTS-12Hz-1.7B-Base` (or `0.6B-Base`), the MLX backend, voice clone "Woman 2".

1. Claude streams text. LiveKit's default `ttsTextTransforms` (`filter_markdown`, `filter_emoji`)
   run on it. `filter_markdown` keeps the newlines (`@livekit/agents` 1.9.1,
   `dist/voice/transcription/text_transforms.js:93`).
2. `VoiceboxSynthesizeStream` sends every piece as `{"type":"text"}` without a change
   (`services/voice-worker/src/voicebox-tts.ts`, the `pump` loop).
3. The Voicebox server cuts the buffer at `[.!?…]+\s+` and calls `.strip()` on each sentence
   (`~/dev/test/voicebox/backend/routes/tts_stream.py`, `_take_ready_segments`). **Here the
   paragraph break is lost**: `\n\n` and ` ` are the same `\s+`.
4. `_speak_worker` synthesizes 1 sentence at a time as its own generation and sends the PCM at once.
   **It adds no silence between 2 sentences.** The next sentence starts at the first sample of its
   own generation.
5. The worker writes the bytes to 1 `AudioByteStream`. It also adds no silence.

Root cause: the only pause between 2 sentences is whatever silence Qwen3-TTS puts at the end of a
generation. That is short, so the sentences play back to back. There is no layer that knows about
paragraphs after step 3.

## 3. Pauses: what the TTS supports

- **SSML: no.** Voicebox has no SSML parser (`grep -ri ssml backend/` finds nothing). The Qwen3-TTS
  model card names no markup at all. A `<break time="500ms"/>` tag would be spoken as text, or be
  noise to the model.
- **A pause control in the model: no.** The only control is `instruct`, and the Base (voice clone)
  model drops it (`backend/backends/__init__.py`: `supports_instruct=False  # Base model drops
  instruct silently`).

So the pause must be inserted as audio: digital silence (PCM zeros) between 2 segments. This is
model-free, exact and costs no GPU time.

### Recommended fix — worker only, no Voicebox change (built 2026-10-31)

Built as described below: `breakAfter` in `speech-segments.ts`, the silence in `VoiceboxSynthesizeStream`, env
`VOICEBOX_SENTENCE_PAUSE_MS` (default 250) and `VOICEBOX_PARAGRAPH_PAUSE_MS` (default 600). The pause is
written at the next `segment_start`, so the last segment of a reply never gets one. The worker log line
now shows `pauses=<s>`. Checks: `pnpm --filter voice-worker check`.

In `VoiceboxSynthesizeStream` (`voicebox-tts.ts`):

1. Keep all text that was sent, as 1 string.
2. On `segment_start`, the server sends the segment's `text`. Find it in the sent text from a cursor,
   and look at the whitespace after it: `\n` in it means a paragraph end, else a sentence end.
3. On `segment_end`, write silence to `bstream`: about 250 ms after a sentence, about 600 ms after a
   paragraph. Put both values in env (`VOICEBOX_SENTENCE_PAUSE_MS`, `VOICEBOX_PARAGRAPH_PAUSE_MS`) for
   a first tune by ear. Do not add silence after the last segment of the reply.
4. Put the boundary lookup in a pure function and test it in `check.ts`, like `segment()` in
   `speech-segments.ts`.

A clause cut (the server's `_CLAUSE_END` cut of a long sentence) must get no pause, or the pause
would split a sentence. The lookup handles this: the text after a clause cut has no sentence-end
punctuation before the whitespace.

Side effects to check: the audio of a reply becomes longer (60 sentences × 250 ms ≈ 15 s for the
`152bb06c` reply). Barge-in is not affected: silence frames are dropped like speech frames on
`cancel`. `speech-watch.ts` counts bytes, so silence alone must not count as speech — the silence is
written only after a segment that had audio.

### Alternative — in the Voicebox server

Keep the boundary type in `_take_ready_segments` and send the silence (or a `pause_ms` field on
`segment_end`) from the server. It is cleaner, because the server knows the boundary exactly. But it
changes the custom Voicebox build and the app on the Mac must be rebuilt and reinstalled. The worker
fix does not need that.

## 4. Emphasis

**The words-4.5 TTS supports no emphasis markup.** There is no SSML `<emphasis>`, and the Base model
ignores `instruct`.

### 4.1 Local models with emphasis markup and an own voice

Research on 2026-10-31. The main measure is the EmphTTS paper (arXiv 2609.27599 v2). It scores word
emphasis with 1 English stress detector (StressLM F1). Human recordings score 0.60:

| Model | Emphasis markup | StressLM F1 |
|---|---|---|
| Qwen3-TTS VoiceDesign | `*word*` (asterisks) | 0.63 |
| Fish Audio S2 (Pro) | `[emphasize]` tag | 0.41 |
| VoxCPM2 | `*word*` | 0.32 |
| CosyVoice3 | `<strong>word</strong>` | 0.26 |

The other candidates have no per-word emphasis. Chatterbox (Turbo), Dia, Orpheus and OmniVoice have
only sound tags such as `[laugh]`. IndexTTS2, Zonos and Spark-TTS have only an emotion or pitch for the
whole clip. Higgs Audio v3 has pause tokens (`<|prosody:pause|>`, `long_pause`) and pitch/speed
tokens, but no emphasis token, and it is non-commercial.

| Candidate | Mac | Own voice | Emphasis | Pause | Streaming | License | In Voicebox |
|---|---|---|---|---|---|---|---|
| **Qwen3-TTS** (fine-tuned Base → custom speaker) | mlx-audio, runs today | fine-tune Base on 1 speaker (`sft_12hz.py`, ~10–100 clips) | `*word*` and `instruct`, **unverified on a fine-tuned speaker** | not documented | yes | Apache-2.0 | yes (Base, CustomVoice, VoiceDesign) |
| **Fish Audio S2 Pro** (4B) | mlx-audio | zero-shot clone (`ref_audio` + `ref_text`) | free-form tags: `[emphasize]` / `[emphasis]` on a word | `[pause]`, `[short pause]` | yes | research license; commercial use needs a deal | no |
| **Higgs Audio v3** (4B) | mlx-audio | zero-shot clone | none per word | exact pause tokens | yes | non-commercial | no |

The agent did not run any model; speed figures are the vendors'. Sources: [EmphTTS](https://arxiv.org/html/2609.27599v2),
[mlx-audio](https://github.com/Blaizzy/mlx-audio), [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS),
[Qwen3-TTS fine-tuning](https://mintlify.com/QwenLM/Qwen3-TTS/advanced/fine-tuning),
[fine-tune reports](https://github.com/QwenLM/Qwen3-TTS/discussions/344), [Fish S2 Pro](https://huggingface.co/fishaudio/s2-pro),
[Higgs Audio v3](https://huggingface.co/bosonai/higgs-audio-v3-tts-4b), [VoxCPM](https://github.com/OpenBMB/VoxCPM),
[CosyVoice](https://github.com/FunAudioLLM/CosyVoice).

### 4.2 Recommendation

1. **Test `*word*` on the current Qwen3-TTS Base first.** It costs nothing: put 5 sentences with and
   without asterisks through Voicebox "Woman 2" and listen. Risk: Base may read the asterisks or
   ignore them, because the 0.63 score was measured on VoiceDesign, which does not clone.
2. **If Base ignores it, fine-tune Base on "Woman 2"** to get a custom speaker on the CustomVoice
   path, which accepts `instruct`. Then test `*word*` again. Risk: it is not known if a fine-tuned
   speaker keeps emphasis; the Qwen3-TTS discussion reports many failed fine-tunes.
3. **Fallback: Fish Audio S2 Pro in a new Voicebox backend** through mlx-audio. It is the only local
   model with a documented per-word emphasis tag, zero-shot clone, pause tags and streaming. Risks:
   no Mac speed figure for a 4B model, a lower emphasis score (0.41), and a license that does not
   allow commercial use without a deal.

Whichever model wins, the tutor prompt must then write the markup (for example `*word*` on the key
word), so it ships as a new prompt version. A TTS that does not read the markup speaks it, so the
markup must go only to the profile that reads it.

## 5. A related cause: the reply is too long

The 50 s single reply is a prompt behaviour: the tutor read 2 full word cards without a stop. Pauses
make this easier to follow, but a shorter reply with a question to the learner after each word would
help more. This is out of scope here and is a separate change to the prompt.
