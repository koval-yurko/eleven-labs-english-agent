import { AudioSession, getDefaultAppleAudioConfigurationForMode } from "@livekit/react-native";

/**
 * Who owns AVAudioSession, and why it cannot be a transport.
 *
 * ## The finding this exists for
 *
 * Stage 0 of docs/2026-08-22-openai-realtime-second-provider.md produced a flawless event stream and
 * TOTAL SILENCE: transcripts arriving, `output_audio_buffer.started` firing, nothing audible. It
 * became audible only if an ElevenLabs lesson had been started first — which is the whole diagnosis.
 *
 * `AudioSession.configureAudio()` and `startAudioSession()` do **not** set the Apple category or
 * mode. That is done by LiveKit's `useIOSAudioManagement`, which watches a **`Room`**'s track state
 * and applies `getDefaultAppleAudioConfigurationForMode(state)` as tracks come and go:
 *
 *     'none'                         → soloAmbient   / default     ← cannot render a WebRTC audio unit
 *     'remoteOnly'                   → playback      / spokenAudio
 *     'localOnly' | 'localAndRemote' → playAndRecord / videoChat
 *
 * A hand-rolled `RTCPeerConnection` has no `Room`, so nothing ever moves the session off
 * `soloAmbient`. An ElevenLabs lesson moves it to `playAndRecord` and LEAVES it there, so the spike
 * was silently free-riding on the other provider's setup.
 *
 * ## Why this is a module and not three lines in an adapter
 *
 * AVAudioSession is ONE PROCESS-WIDE RESOURCE. An adapter that configures it privately fights the
 * other one — last writer wins, and the loser fails as *silence* rather than as an error, which is
 * the hardest failure in this codebase to diagnose (it took a "works only after an ElevenLabs
 * lesson" clue to find it the first time).
 *
 * ## What could NOT be done, and it matters
 *
 * The obvious design — take ownership away from both adapters — is not available.
 * `@elevenlabs/react-native/src/index.react-native.ts` calls `configureAudio()` and
 * `startAudioSession()` inside its own session setup and `stopAudioSession()` on detach, with no
 * option to disable any of it. So this module owns the POLICY and RE-ASSERTS it; it does not own
 * the session exclusively, and pretending otherwise would be a comment that lies.
 *
 * The sharp end is `stopAudioSession()` on the ElevenLabs detach path being **global**. Today that
 * is harmless — one provider at a time. The day two transports can be live in one process, ending an
 * ElevenLabs session tears the audio session out from under the other one and the symptom is
 * silence. `ensureStarted()` below exists for that day; nothing calls it yet, and the comment is the
 * point.
 */

/**
 * The category a two-way voice lesson needs: `playAndRecord` / `videoChat`.
 *
 * Taken from LiveKit's own table rather than hand-written, so a LiveKit upgrade that retunes it
 * retunes this too. `preferSpeakerOutput: true` selects `videoChat`, which defaults the route to the
 * speaker — what a tutor lesson wants, and what the ElevenLabs path already produces.
 */
const VOICE_LESSON_CONFIG = getDefaultAppleAudioConfigurationForMode("localAndRemote", true);

/**
 * Put the session into the voice-lesson category, and report whether it worked.
 *
 * Returns `false` rather than throwing: an audio session that refuses to configure is a lesson that
 * will be silent, and the caller's job is to SAY so — the same rule `setOutputSilenced` follows.
 *
 * Call this when a transport that does not manage its own session starts, and AGAIN when its remote
 * track arrives: the WebRTC audio unit reconfigures the session as it starts, and iOS resets the
 * category on some route changes. LiveKit re-applies on every track-state change; this is the same
 * answer with two states.
 */
export async function applyVoiceLessonCategory(): Promise<boolean> {
  try {
    await AudioSession.setAppleAudioConfiguration(VOICE_LESSON_CONFIG);
    return true;
  } catch {
    return false;
  }
}

/** What `applyVoiceLessonCategory` sets, for a status line or a log that has to name it. */
export const VOICE_LESSON_CATEGORY = `${VOICE_LESSON_CONFIG.audioCategory}/${VOICE_LESSON_CONFIG.audioMode}`;

/**
 * Start the audio session if nothing else has, then apply the category.
 *
 * For a transport whose SDK does NOT do this for us. It is idempotent on the native side, and it is
 * also the repair path for the global `stopAudioSession()` described above — a transport that is
 * still live when another one detaches calls this to get its route back.
 */
export async function ensureStarted(): Promise<boolean> {
  try {
    await AudioSession.configureAudio({ ios: { defaultOutput: "speaker" } });
    await AudioSession.startAudioSession();
  } catch {
    return false;
  }
  return applyVoiceLessonCategory();
}

/**
 * Release the audio session.
 *
 * Deliberately NOT called anywhere yet. The only transport in the app stops the session itself on
 * detach, and a second `stopAudioSession()` racing that one is exactly the class of bug this module
 * exists to prevent. It is here so the OpenAI adapter — which has nothing stopping the session for
 * it — has a named counterpart to `ensureStarted()` rather than reaching for `AudioSession` directly
 * and re-scattering the ownership this file just collected.
 */
export async function release(): Promise<void> {
  try {
    await AudioSession.stopAudioSession();
  } catch {
    // A session that will not stop is not worth failing a teardown over.
  }
}
