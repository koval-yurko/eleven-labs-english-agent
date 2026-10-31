# Prompt version customization (declarative options per version)

Card: "Prompt variant - additional options". Goal: a learner can customize the selected tutor
version on the phone. A "Customize" link below the version select opens a modal. The modal shows
the options that this version declares, and the app saves the values for the next sessions on this
version. One generic UI renders every version's options. A version only declares its options as
data.

First version with options: `words-4.5`. Its options: TTS model, STT model, voice, voice speed.

Status: built (section 10), without voice speed. Section 9 records the decisions. Voice speed
moved to a separate card.

## 1. What exists today

### 1.1 The version picker on the phone

- The picker is the "Tutor" `Select` in `apps/mobile/src/app/lessons/[id]/index.tsx:763-773`. It
  shows only when the API offers more than 1 version. It is disabled while a session is live.
- The list comes from `GET` `API_V2_ROUTES.agentVersions`
  (`services/api/src/routes/v2/agent-versions/route.ts`). The DTO is `AgentVersionSummary`
  `{ version, label, provider }` (`packages/shared/src/api.ts:441-458`). No voice data reaches the
  client.
- The app saves the chosen version on the device only: `expo-sqlite/kv-store`, key
  `pref:tutor-version` (`apps/mobile/src/lib/tutor-preference.ts`). There is no server-side
  preference and no settings table (`supabase/migrations/0001`–`0021`).

### 1.2 How a version reaches the voice worker

1. The phone sends `RealtimeTokenRequest { lessonId, items, version? }` to the LiveKit token route
   (`services/api/src/routes/v2/words-agent/livekit-token/route.ts`).
2. The route finds the `PromptVersion` and builds `LiveKitDispatchMetadata`
   (`packages/shared/src/tutor/livekit-wire.ts:180-210`): `instructions`, `llm`, `tts`, `stt`,
   `autoContinue`. `worker` selects the agent name (`tutor` or `tutor-local`).
3. The worker reads the metadata in `services/voice-worker/src/agent.ts` (`:165-169`, `:282-295`)
   and calls `createTtsFor(metadata.tts)` and `createSttFor(metadata.stt)`.
4. A TTS or STT profile is a key with no parameters
   (`tts-profiles.ts`, `stt-profiles.ts`). The model, voice and language come from env vars or
   from constants. `words-4.5` names `stt: "voicebox-qwen-asr-0.6b"` and
   `tts: "voicebox-local-woman-2"`.

`LiveKitDispatchMetadata.voice` is declared but nothing sets it and the worker does not read it.

### 1.3 What `words-4.5` runs on

`words-4.5` runs on the Mac worker (`tutor-local`). Both the STT and the TTS are the local
Voicebox server (`127.0.0.1:17493`, our build `0.6.0-custom.1`). The source is
`~/dev/test/voicebox` (read for this research, not changed).

## 2. Voice speed: the answer

**Voicebox cannot change the speed of a streamed reply today. The speed is also not a property
of the voice.** So the speed cannot be set when the voice is created, and it cannot be set per
request on the routes that the worker uses.

The facts (paths under `~/dev/test/voicebox/backend/`):

| Where | Speed? |
|---|---|
| `WS /tts/ws` `start`, `POST /tts/stream` (`routes/tts_stream.py:44-63`) | No field |
| `POST /generate` (`models.py:93-117`) | No field |
| Voice profile (`models.py:29-66`, DB columns) | No field |
| `POST /v1/audio/speech` (`routes/openai_compat.py:114`, `:251-258`, `:402`) | Yes, `speed` 0.25–4.0, but it is not streamed: `librosa.effects.time_stretch` on the full clip |
| Kokoro and LuxTTS engines | Hard-coded `speed=1.0` |

**`instruct` ("speak slowly") does not work for a Qwen voice clone.** The `/tts/ws` start accepts
`instruct`, but the MLX backend never passes it to the model (`mlx_backend.py:223`, `:283-301`,
`:369`, `:394-415`). The PyTorch backend passes it, and `qwen_tts` drops it, because
`generate_voice_clone` has no `instruct` parameter. Only the CustomVoice and VoiceDesign engines
read `instruct`, and they are not voice clones. Outside sources agree that the Qwen3-TTS Base
(clone) model has no instruction control, and that hosted Qwen3-TTS APIs implement `speed` as a
time stretch after synthesis, not with streaming
([vLLM-Omni](https://docs.vllm.ai/projects/vllm-omni/en/v0.18.0/user_guide/examples/online_serving/qwen3_tts/),
[mittwald](https://developer.mittwald.de/docs/v2/platform/aihosting/models/qwen3-tts-customvoice/)).

For comparison, Deepgram Aura-2 (the `deepgram` TTS profile) accepts a native `speed` of 0.7–1.5
on its streaming WebSocket ([Deepgram voice controls](https://developers.deepgram.com/docs/tts-voice-controls.md)).
`words-4.5` does not use Deepgram TTS.

### 2.1 How we can add speed

| Option | Where | Quality | Cost |
|---|---|---|---|
| A. Time stretch in the worker | A streaming WSOLA/Sonic stage on the PCM frames, after any TTS | Good for speech in 0.75–1.25. The pitch stays the same. | One TS module (~250 lines) in `services/voice-worker`. Works for every TTS profile. |
| B. Time stretch in our Voicebox build | A new `speed` field on `/tts/ws` `start`; stretch each segment on the server | Good, but a phase vocoder on 320 ms chunks gives artifacts at chunk edges. Per sentence, it delays the first audio. | A change in the Voicebox fork, and a new custom release. |
| C. Change the playback rate | Resample in the worker | Bad: the pitch changes too ("chipmunk") | Small |

**Recommendation: option A.** It keeps the first-audio latency (it works on each frame as the
frame arrives). It needs no Voicebox release. It also gives speed to `voicebox`, `qwen` and
`deepgram` profiles without a separate path for each. Range: 0.75–1.25, step 0.05, default 1.0.
A slower voice is the main use for a learner. Above 1.25, speech-optimized WSOLA starts to sound
rough.

The Sonic algorithm (the speed-up used by Android TalkBack, Apache 2.0) is the reference
implementation. It is pitch-synchronous (it finds the pitch period and drops or repeats whole
periods), so it is good for voice. An npm package is an option, but the existing JS ports are small
and old. A local TS port is easy to test with `check.ts`.

The stretch changes the audio length. The live transcription follows the timing of the audio
frames, so it must receive the stretched frames. Section 7 lists this as a risk.

## 3. Options that `words-4.5` can offer

### 3.1 TTS model

Voicebox engines (`backends/__init__.py:237-247`): `qwen`, `qwen_custom_voice`,
`qwen_voice_design`, `luxtts`, `chatterbox`, `chatterbox_turbo`, `tada`, `kokoro`, `omnivoice`.
A cloned voice profile ("Woman 2", "Men 1") works only with a cloning engine. The adapter sends
only `model_size` today, so the engine is the profile's default (`qwen`).

Proposed options, first release:

| Value | Label | Sent as |
|---|---|---|
| `1.7B` (default) | Qwen3-TTS 1.7B — better voice | `model_size: "1.7B"` |
| `0.6B` | Qwen3-TTS 0.6B — faster | `model_size: "0.6B"` |

The 0.6B model must be downloaded in Voicebox first. Other engines (Chatterbox, LuxTTS) need an
`engine` field in the adapter and a device test. Keep them out of the first release.

### 3.2 STT model

`/stt/ws` accepts `whisper-base`, `whisper-small`, `whisper-medium`, `whisper-large`,
`whisper-turbo`, `qwen-asr-0.6B`, `qwen-asr-1.7B`, `voxtral-realtime-4B`
(`backends/__init__.py:490-575`). The worker already has a profile for 4 of them.

Proposed options (the value is an STT profile key from `stt-profiles.ts`):

| Value | Label |
|---|---|
| `voicebox-qwen-asr-0.6b` (default) | Qwen3-ASR 0.6B (Mac) |
| `voicebox-qwen-asr-1.7b` | Qwen3-ASR 1.7B (Mac) |
| `voicebox-whisper-turbo` | Whisper large-v3 turbo (Mac) |
| `voicebox-whisper-base` | Whisper base (Mac) |
| `deepgram` | Deepgram Flux (cloud) |

`deepgram` works on the Mac worker only when `DEEPGRAM_API_KEY` is in its `.env` (`words-4.4`
uses it there today).

### 3.3 Voice

`GET /profiles` on Voicebox lists the voices (`routes/profiles.py:39`: `id`, `name`,
`voice_type`, …). But only the Mac worker can reach it. The API on Vercel cannot, and the phone
must not. So the first release uses a **fixed list in the version module**:

| Value (a name; the worker maps it to the Voicebox id) | Label |
|---|---|
| `woman-2` (default) | Woman 2 |
| `men-1` | Men 1 |

A dynamic list (the worker publishes its voices) is a later step. Section 9 Q3.

### 3.4 Voice speed

A number from 0.75 to 1.25, step 0.05, default 1.0, applied by the worker (section 2.1 option A).

## 4. The declarative schema

A version declares its options as data in its prompt module. The type lives in
`packages/shared` (pure types and one pure validator, no runtime dependency), because the API,
the phone and the worker must agree on it.

```ts
// packages/shared/src/tutor/customization.ts
export type OptionValue = string | number | boolean;

interface FieldBase {
  /** Stable key; the saved values and the wire use it. */
  key: string;
  label: string;
  help?: string;
  /** Which worker setting the value drives. The UI does not read it. */
  target: CustomizationTarget;
}

export type CustomizationField =
  | (FieldBase & { kind: "select"; default: string; options: { value: string; label: string; help?: string }[] })
  | (FieldBase & { kind: "number"; default: number; min: number; max: number; step: number; unit?: string })
  | (FieldBase & { kind: "boolean"; default: boolean });

/** `<stage>.<key>`: the stage is closed, the key belongs to the selected profile (§10). */
export type CustomizationTarget = `${"stt" | "tts"}.${string}`;

export interface CustomizationSchema {
  fields: CustomizationField[];
}

export type CustomizationValues = Record<string, OptionValue>;

/**
 * Pure: unknown keys are dropped, a wrong type or an out-of-range value falls back to the
 * default, a number snaps to the step. The API and the phone run the same function.
 */
export function resolveCustomization(schema: CustomizationSchema, values: unknown): CustomizationValues;
```

`words-4.5` then adds one field to its module:

```ts
customization: {
  fields: [
    { key: "ttsModel", target: "tts.model", kind: "select", label: "Voice model", default: "1.7B",
      options: [{ value: "1.7B", label: "Qwen3-TTS 1.7B", help: "Better voice" },
                { value: "0.6B", label: "Qwen3-TTS 0.6B", help: "Faster" }] },
    { key: "sttModel", target: "stt.profile", kind: "select", label: "Speech recognition", default: "voicebox-qwen-asr-0.6b",
      options: [/* section 3.2 */] },
    { key: "voice", target: "tts.voice", kind: "select", label: "Voice", default: "woman-2",
      options: [/* section 3.3 */] },
    { key: "speed", target: "tts.speed", kind: "number", label: "Voice speed", default: 1,
      min: 0.75, max: 1.25, step: 0.05, unit: "×" },
  ],
},
```

Why `target` and `key` are separate: the UI and the saved values use `key`. The worker reads only
`target`. A later version can rename a label or a key without a worker change. Section 10 explains
why the key part of `target` is open.

Why not JSON Schema or zod: `packages/shared` must stay free of dependencies. We need 3 field
kinds, and a tagged union of field kinds lets the compiler check every version module. The shape is plain JSON,
so it goes over the wire as it is.

## 5. Data flow

1. **List.** `AgentVersionSummary` gets `customization?: CustomizationSchema`. The agent-versions
   route copies it from the `PromptVersion`. A version without the field shows no "Customize"
   link.
2. **Edit.** The phone renders the modal from the schema. "Save" stores the values on the device,
   key `pref:tutor-options:<version>` (the same `kv-store` as `pref:tutor-version`). "Reset"
   removes the key.
3. **Start.** `RealtimeTokenRequest` gets `options?: CustomizationValues`. The phone sends the
   saved values for the chosen version.
4. **Validate.** The token route runs `resolveCustomization(version.customization, body.options)`.
   It then turns each value into a dispatch override by its `target`:
   `LiveKitDispatchMetadata.overrides?: Partial<Record<CustomizationTarget, OptionValue>>`.
   A version without a schema sends no overrides, whatever the phone sends.
5. **Apply.** The worker reads `metadata.overrides`:
   - `stt.profile` replaces `metadata.stt` (an unknown key falls back, as today).
   - `tts.voice` and `tts.model` go to the TTS profile's `create(overrides)`. `voiceboxProfile`
     uses them as `profileId` and `modelSize`. A profile that does not know a target ignores it
     and logs it.
   - `tts.speed` wraps the TTS output in the time stretch stage (skipped at 1.0).
   - The session-start log line prints the overrides that it applied.

`TtsProfile.create()` becomes `create(overrides?: TtsOverrides)`. That is the only change to the
profile registry.

### 5.1 Why save on the device

The chosen version is saved on the device today, so the options of that version go in the same
place. There is no settings table, and 1 learner uses 1 phone. A server table
(`tutor_preferences`, owner-scoped, `version` + `values jsonb`) is the step when a second device
or a web client needs the same values. Section 9 Q1.

### 5.2 When the schema changes

The saved values pass through `resolveCustomization` on the phone (to show them) and on the API
(to use them). If an option is removed or a range changes, a stale saved value falls back to the
default. Nothing fails.

## 6. The generic modal (mobile)

- **Link.** A "Customize" `Link` below the Tutor select, shown when the selected version has a
  schema. Disabled while a session is live: the dispatch metadata is fixed for one session. The
  select shows only with more than 1 version, so the link must also show when the select does
  not.
- **Modal.** `TutorOptionsModal({ version, schema, open, onOpenChange })` in
  `apps/mobile/src/lib/`, modelled on `DiagnosticsModal`. One row for each field:
  - `select` → the existing `Select` component (label, options, help text below).
  - `number` → a slider with the value and unit (`1.10×`). There is no slider in `src/ui` today.
    Add `@react-native-community/slider` (an Expo SDK module). A stepper (− / +) is the
    alternative with no new dependency.
  - `boolean` → the existing `Checkbox`.
- Buttons: "Save", "Cancel", "Reset to defaults". A short line under the link shows the values
  that differ from the defaults, for example "Men 1 · 0.90×".

The modal knows nothing about TTS or STT. A new version with new fields needs no UI change.

## 7. Risks

1. **Time stretch and the transcript timing.** The live transcription on the phone (commit
   `2f8a1a5`) follows the audio frames that the `AgentSession` publishes. So the stretch must be
   inside the `tts.TTS` object (a wrapper around the profile's TTS), and every frame that leaves it
   must already have the stretched length. The Qwen pacer (`pacer.ts`) also estimates audio length
   from characters; it must divide by the speed. A device test must check that the caption stays
   in time at 0.8× and 1.2×.
2. **Barge-in.** The stretch stage holds a short buffer (~20–30 ms). On an interruption it must
   be flushed and dropped, or the old reply plays for a moment.
3. **A model that is not downloaded.** Qwen3-TTS 0.6B or Whisper turbo may be missing on the
   Mac. Voicebox then refuses at session start with its reason, and the lesson has no voice. The
   worker already logs the reason. The help text in the modal must say "must be downloaded on the
   Mac".
4. **The warmup.** `VoiceboxTTS.warm()` must use the chosen voice and model size, or the first
   reply loads the model cold (~35 s).
5. **Version identity.** Before, a version string fixed the voice. With options, 2 sessions of
   `words-4.5` can sound different. The stored session row must keep the options that it used
   (`lesson_sessions` or the debug report). Otherwise a report cannot be repeated.

## 8. Plan of work

1. `packages/shared`: `customization.ts` (types and `resolveCustomization`), property checks in
   `check:shared`. `AgentVersionSummary.customization?`, `RealtimeTokenRequest.options?`,
   `LiveKitDispatchMetadata.overrides?`.
2. `packages/server`: `PromptVersion.customization?`. Add the schema to `words-4.5.ts`. The
   registry copies it to `ActiveVersion`.
3. `services/api`: the agent-versions route returns the schema. The token route validates the
   options and sets `overrides`.
4. `services/voice-worker`: `create(overrides)` on TTS profiles, `stt.profile` override, the
   Sonic time-stretch stage with checks in `check.ts`, the log line, the warmup.
5. `apps/mobile`: the device store, the "Customize" link, `TutorOptionsModal`, the slider, the
   `options` field in the token request.
6. Run `pnpm typecheck`, `pnpm lint`, `pnpm check:shared`, `pnpm --filter mobile check`. Test on a
   device with the Mac worker: each voice, each model, speed 0.8 and 1.2.

`words-4.5` keeps its name. The schema defaults equal what 4.5 runs today, so a session with no
saved options sounds the same as before. No `pnpm sync:agents` run is needed: LiveKit versions are
not provisioned.

## 9. Decisions (confirmed 2026-10-30)

| Question | Decision |
|---|---|
| Q1. Where to save the values | On the device (`kv-store`) |
| Q2. How to add speed | Moved to a separate card. Not in this build. |
| Q3. Where the voice list comes from | A fixed list in `words-4.5.ts` |
| Q4. The TTS model list | A fixed list in `words-4.5.ts`: Qwen3-TTS 1.7B and 0.6B |
| Q5. Slider or stepper | A slider (`@react-native-community/slider`) for every `number` field |

The questions as they were asked:

- **Q1. Where to save the values.** Recommended: on the device (`kv-store`), like the chosen
  version. Alternative: a Supabase table, so the values follow the learner to other devices.
- **Q2. How to implement speed.** Recommended: a time stretch in the worker (option A). The
  alternative is a `speed` field in our Voicebox fork (option B), which needs a new release.
- **Q3. Where the voice list comes from.** Recommended: a fixed list in `words-4.5.ts` (Woman 2,
  Men 1). Alternative: the Mac worker reads `GET /profiles` and publishes the list, so every
  Voicebox voice shows.
- **Q4. The TTS model list.** Recommended: Qwen3-TTS 1.7B and 0.6B only. Other engines
  (Chatterbox, LuxTTS) need an adapter change and a device test.
- **Q5. Slider or stepper** for the speed. Recommended: `@react-native-community/slider`.

## 10. What was built

The design above, with these differences:

- **No speed.** The `number` field kind and its slider exist, so the speed card only adds a field
  and the worker stage.
- **Open targets (changed after review, 2026-10-30).** The first build closed the targets in
  `packages/shared` (`stt.profile | tts.model | tts.voice`). That made every new provider option a
  change in shared code, and it broke the rule that the worker owns its registry (`tts` / `stt` are
  plain strings in `LiveKitDispatchMetadata`). Now:
  - `CustomizationTarget` is `` `${"stt" | "tts"}.${string}` ``: the stage is closed, the key is open.
  - `profile` is the one reserved key: `stt.profile` / `tts.profile` select the profile.
  - Every other key belongs to the selected profile. `TtsProfile.accepts` / `SttProfile.accepts`
    list the keys it reads (Voicebox TTS: `voice`, `model`; every STT profile: none today). A new
    provider adds its own keys in its own profile, with no change to shared code.
  - `LiveKitDispatchMetadata.overrides` is grouped by stage: `{ tts: { voice: "…" }, stt: { profile: "deepgram" } }`.
  - The cost: a key typo in a prompt module is not a compile error. The worker drops the key and
    logs it when it builds the profile (`TTS profile "…" ignores options: voise`).
- **The modal is `apps/mobile/src/lib/tutor-options-modal.tsx`.** The form mounts each time the
  modal opens, so the draft always starts from the saved values. "Reset to defaults" changes the
  draft only; "Save" stores it.
- **The phone stores only the values that differ from the defaults** (`changedCustomization`).
  **The token route sends every field to the worker, defaults included** (`customizationOverrides`).
  A default left out would let a worker env var (for example `VOICEBOX_MODEL_SIZE`) win over the
  value the modal shows as selected (ponytail-review finding 2). The defaults equal what
  `words-4.5` runs, so a learner who never opened the modal hears the version as before.
- **The phone's `session.start` event records the options** (only the changed ones, as JSON), so a
  debug report says which voice and models the lesson ran with.
- **The options travel in `TutorStartRequest.options`.** The lesson screen reads them for the
  chosen version and passes them to `start`; the LiveKit adapter sends them in the token request.
- **The worker:** `overrides.ts` (`sessionVoice`) returns a profile id and its options for each
  stage. `profile-options.ts` (`splitOptions`) gives a profile only the keys in its `accepts`.
  Voicebox TTS reads `voice` and `model`, so the warmup and every socket use the chosen voice and
  model size. The session-start log line prints the applied options; `createTtsFor` /
  `createSttFor` log the keys a profile ignores.
- **Voices are names, not ids.** `words-4.5.ts` offers `woman-2` and `men-1`. `VOICEBOX_VOICES` in
  `tts-profiles.ts` maps a name to this Mac's Voicebox id, so the ids exist only in the worker. An
  unknown name keeps the profile's own voice and logs it.

### New dependency

`@react-native-community/slider` 5.2.0 is a native module. **Ship this code in a new native build
(TestFlight), not as an OTA update.** The lesson screen imports the modal, and the modal imports the
slider. On an older binary the slider's native view is missing, so the lesson screen can fail when
it loads, even though `words-4.5` has no `number` field yet.

### Not yet tested on a device

Typecheck, lint, the shared, worker and mobile logic checks and the iOS bundle pass. A device test
with the Mac worker must still check each voice, each TTS model and each STT model.

## Sources

- Voicebox source: `~/dev/test/voicebox/backend/` (`routes/tts_stream.py`, `routes/stt_stream.py`,
  `routes/openai_compat.py`, `routes/profiles.py`, `backends/mlx_backend.py`, `backends/__init__.py`).
- [Deepgram TTS voice controls](https://developers.deepgram.com/docs/tts-voice-controls.md)
- [vLLM-Omni Qwen3-TTS serving](https://docs.vllm.ai/projects/vllm-omni/en/v0.18.0/user_guide/examples/online_serving/qwen3_tts/)
- [mittwald Qwen3-TTS CustomVoice](https://developer.mittwald.de/docs/v2/platform/aihosting/models/qwen3-tts-customvoice/)
- Related: `docs/2026-10-30-livekit-voicebox-plugins-node.md`, `docs/2026-06-27-agent-prompt-version-switching.md`.
