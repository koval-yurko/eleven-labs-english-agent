/**
 * Silence the tutor locally, because the ElevenLabs SDK cannot do it on React Native.
 *
 * ## The bug this exists for
 *
 * `useConversation().setVolume({ volume: 0 })` is a **no-op on React Native**, silently. The call
 * reaches `WebRTCConnection.setAudioVolume`, which is `this.audioAdapter?.setVolume(volume)` — and
 * the adapter is only ever registered by the SDK's *web* entrypoint. `index.react-native.js`
 * registers a setup strategy and a native volume provider, never an audio adapter, so
 * `createAudioAdapter()` returns `null` and the optional call evaporates. The SDK's own docblock on
 * `WebRTCAudioAdapter` says as much: *"React Native: no-op (LiveKit handles playback natively)"*.
 *
 * A held pause that only muted the microphone therefore left the tutor **audible** — and its turns
 * are long teaching monologues, so "pause" meant listening to another minute of explanation.
 *
 * ## Why it has to reach through the SDK
 *
 * LiveKit *does* support this on React Native: `RemoteAudioTrack.setVolume()` branches on
 * `isReactNative()` and calls `_mediaStreamTrack._setVolume(v)`, which is a real native gain control
 * in `@livekit/react-native-webrtc` (0–10, default 1) that works on **remote** tracks. But the
 * ElevenLabs SDK constructs the `Room` internally and exposes it only through
 * `WebRTCConnection.getRoom()`, which hangs off `BaseConversation.connection` — a `protected` field.
 * `useRawConversation()` is a documented escape hatch to the `Conversation`; the hop from there to
 * the connection is not.
 *
 * So every step is feature-detected rather than typed, and the function reports how many tracks it
 * actually reached. A future SDK version that renames the field turns this into `0` — which the
 * screen shows in the paused status line instead of quietly going back to an audible pause.
 *
 * The alternative — ask ElevenLabs to register an RN audio adapter, or to forward room options — is
 * the real fix and worth an upstream issue. This is what works today.
 *
 * See docs/2026-08-16-tutor-pause-hold-the-line.md §4.4.
 */

/** The one method we need, structurally typed — see the docblock for why nothing here is imported. */
type RemoteAudioTrackLike = { setVolume: (volume: number) => void };

type RoomLike = { remoteParticipants?: Map<string, unknown> };
type ParticipantLike = { audioTrackPublications?: Map<string, unknown> };
type PublicationLike = { track?: unknown };
type ConversationLike = { connection?: { getRoom?: () => unknown } };

function remoteAudioTracks(conversation: unknown): RemoteAudioTrackLike[] {
  const room = (conversation as ConversationLike | null | undefined)?.connection?.getRoom?.() as
    | RoomLike
    | undefined;
  const participants = room?.remoteParticipants;
  if (!participants || typeof participants.forEach !== "function") return [];

  const tracks: RemoteAudioTrackLike[] = [];
  participants.forEach((participant) => {
    const publications = (participant as ParticipantLike).audioTrackPublications;
    if (!publications || typeof publications.forEach !== "function") return;
    publications.forEach((publication) => {
      const track = (publication as PublicationLike).track as RemoteAudioTrackLike | undefined;
      if (track && typeof track.setVolume === "function") tracks.push(track);
    });
  });
  return tracks;
}

/**
 * Set the playback gain of every remote (agent) audio track. `0` silences the tutor instantly,
 * mid-word; `1` restores it.
 *
 * Returns the number of tracks reached — **0 means the tutor is still audible**, and the caller is
 * expected to say so rather than claim a silence it did not deliver. Never throws: a pause must not
 * be able to crash a live lesson.
 */
export function setAgentAudioVolume(conversation: unknown, volume: number): number {
  try {
    const tracks = remoteAudioTracks(conversation);
    for (const track of tracks) track.setVolume(volume);
    return tracks.length;
  } catch {
    return 0;
  }
}
