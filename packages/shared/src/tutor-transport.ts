/**
 * The contract between a tutor session and whatever is actually carrying the voice.
 *
 * ## Why this exists
 *
 * Until 2026-08-22 there was exactly one provider — ElevenLabs Conversational AI — and its SDK's
 * shape *was* the session's shape: `useConversation`'s eight callbacks, its `startSession` argument
 * and its `{ errorType, code, debugMessage }` error payload were read directly by
 * `lib/tutor-session.tsx`. Stage 0 of docs/2026-08-22-openai-realtime-second-provider.md proved on a
 * device that the OpenAI Realtime API can carry the same lesson, so that coupling is now a cost.
 *
 * **This file is the only thing a second provider has to satisfy.** Everything the session does
 * around it — the pause machine, ownership, the journal, the lock-screen card, the per-conversation
 * save guard, the resume context — is about the LESSON and names no vendor. It was already like
 * that; this makes it true of the transport too.
 *
 * ## Why it lives in `packages/shared`
 *
 * The `mirror-store.ts` precedent exactly: an interface both clients must agree on, with the
 * implementations living per-platform. It also passes the repo's own test (CLAUDE.md) — a bug in
 * this CONTRACT is a bug on the server too, because the server is what mints the credential the
 * contract describes and what stamps the `conversationId` it carries.
 *
 * Types only. No React, no npm, no runtime — a transport is a hook on React Native and need not be
 * one anywhere else, so the hook-ness is expressed in `apps/mobile/src/lib/transport/`, not here.
 *
 * ## What is deliberately NOT here
 *
 * **The audio session.** On iOS AVAudioSession is one process-wide resource, and an adapter that
 * configures it privately fights the other one — last writer wins and the loser fails as *silence*,
 * not as an error. The POLICY (which category a voice lesson needs) is owned by one module,
 * `apps/mobile/src/lib/audio-session.ts`; adapters are its callers.
 *
 * **This was a capability flag until stage 2 and should not have been.** The idea was that the
 * session would assert the category for any transport whose SDK did not. Writing the second adapter
 * showed why that cannot work: the assertion has to happen when the local track opens and again when
 * the remote track arrives — moments only the transport can see, and both before it ever reports
 * `"connected"`. A session-level effect keyed on status fires too late to help and too coarsely to
 * be right. So there is no flag: the module decides *what*, the adapter decides *when*, and the
 * session is not involved. See §4.1 and §7 of the stage-0 document.
 */
import type { TranscriptLine, TutorItem } from "./tutor";

/**
 * The states a line can be in. **Five, and the two odd ones are load-bearing.**
 *
 * This is the UNION of two different unions the ElevenLabs SDK actually uses, because the session
 * reads both and stage 1 changes no behaviour:
 *
 *   - `useConversation().status` is `"disconnected" | "connecting" | "connected" | "error"`
 *   - the `onStatusChange` callback carries `"disconnected" | "connecting" | "connected" | "disconnecting"`
 *
 * Collapsing either extra value into `"disconnected"` would be a real behaviour change, not a
 * simplification. `focusLesson` refuses while `status !== "disconnected"` — so during `"disconnecting"`
 * the refusal holds, and folding it away would let a screen steal focus from a session that is
 * mid-hangup. The ownership effect keys on the same comparison, so `"error"` deliberately does NOT
 * release ownership.
 *
 * A provider populates whichever subset it has; nothing requires all five. A hand-rolled WebRTC
 * transport maps `new`/`connecting` → `"connecting"`, `connected` → `"connected"`, `failed` →
 * `"error"`, `closed`/`disconnected` → `"disconnected"`, and synthesises `"disconnecting"` around
 * its own `end()` if it wants the same refusal window.
 */
export type TutorStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";

/**
 * Why a line went down, as reported by the transport rather than inferred by the session.
 *
 * `"user"` means WE hung up, `"agent"` means the far end did (the tutor finished, or a duration cap
 * fired), `"error"` means it broke. `lib/tutor-session.tsx` turns these into `PauseReason`, and the
 * distinction between "you stopped this" and "this stopped" is the whole of what it uses them for.
 *
 * A provider that does not report this must SYNTHESISE it — an adapter that cannot tell a deliberate
 * hangup from a failure keeps a flag over its own `end()` and calls everything else `"error"`. That
 * is a real asymmetry (the OpenAI transport has no such signal) and it belongs in the adapter, not
 * in the session, which is why this is a closed set rather than a passthrough.
 */
export type TutorEndReason = "user" | "agent" | "error";

/**
 * What a provider can actually DO, asked rather than assumed.
 *
 * The rule these exist to enforce comes from `lib/agent-audio.ts`: a control that silently does
 * nothing is worse than a missing one, because the UI goes on claiming it worked. The session reads
 * these and either takes the good path or takes the documented fallback — it never calls a method
 * and hopes.
 */
export interface TutorCapabilities {
  /**
   * Can the tutor's own audio be silenced locally, mid-word?
   *
   * ElevenLabs on React Native: only through the escape hatch in `lib/agent-audio.ts`, which is why
   * `setOutputSilenced` returns a boolean rather than `void` — see there.
   */
  silenceOutput: boolean;
  /**
   * Does the platform need a keep-alive to stop it re-engaging during a held pause?
   *
   * ElevenLabs: yes — `turn_timeout` makes the tutor talk into an empty room, and the held pause
   * pings `user_activity` every `TUTOR_HEARTBEAT_MS` to stop it. OpenAI: no — with VAD on and
   * nobody speaking the model simply waits, so `keepAlive()` is a no-op and the session must not
   * run a timer for it.
   */
  userActivity: boolean;
  /**
   * Can an in-flight turn be stopped WITHOUT spending a turn?
   *
   * ElevenLabs: no. The held pause fakes it by sending `PAUSE_STOP_MESSAGE` as a user message,
   * which costs a turn and has to be filtered back out of the transcript by
   * `HIDDEN_KICKOFF_MESSAGES`. OpenAI: yes, `response.cancel` + `output_audio_buffer.clear`.
   */
  cancelTurn: boolean;
  /**
   * Does a barge-in yield a corrected transcript for the turn that was cut off?
   *
   * Both providers do, and the session needs only the boolean — but the WORK behind
   * `onTurnCorrected` differs completely: ElevenLabs pushes the correction into a callback, while
   * OpenAI has to be asked (`conversation.item.truncated` → `conversation.item.retrieve`). The
   * adapter absorbs that; the session sees one event either way.
   */
  responseCorrection: boolean;
}

/** What the session asks for when it starts a lesson. Provider-neutral by construction. */
export interface TutorStartRequest {
  lessonId: string;
  /**
   * The lesson's active words with their enrichment. How they reach the agent is the ADAPTER's
   * problem and the providers disagree about it: ElevenLabs injects `formatItemsList(items)` as the
   * `items_list` dynamic variable, OpenAI has no dynamic variables and interpolates the same string
   * into `session.instructions` server-side. The session should not know which.
   */
  items: TutorItem[];
  /** The prompt version to run, or `null` for the provider's default. */
  version: string | null;
}

/**
 * What starting a session yields. Both fields come from the SERVER, never from the transport's own
 * idea of them — that is the whole point of returning them rather than reading them off a callback.
 */
export interface TutorSessionDescriptor {
  /**
   * THE ROW KEY. Four writers converge on one `lesson_sessions` row keyed by this column, so it is
   * minted server-side and seeded before the transport connects. A DERIVED id silently forks a
   * learner's history weeks before anyone notices; a refused session is visible and correctable now.
   * See `ConversationTokenResponse` in `api.ts`.
   */
  conversationId: string;
  /** The version actually resolved, which differs from the request when none was asked for. */
  version: string;
}

/**
 * Everything a transport tells the session. One object, passed once — an adapter is expected to
 * hold it in a ref and read the latest, because these close over the render that made them.
 */
export interface TutorTransportEvents {
  onStatus(status: TutorStatus): void;
  /** One finished turn, either role. Ordering is the transport's promise, not the session's. */
  onTurn(line: TranscriptLine): void;
  /**
   * A turn the learner cut off, restated as what was actually HEARD. Without this the record claims
   * the teacher finished sentences the learner interrupted — in an app whose whole premise is
   * interrupting freely. Matched on the previous text rather than an id, because that is the only
   * handle both providers offer.
   */
  onTurnCorrected(previous: string, corrected: string): void;
  /** Why the line went down. Called exactly once per session, after the last `onTurn`. */
  onEnd(reason: TutorEndReason): void;
  /**
   * Already ONE SENTENCE for the learner — the adapter has done the wording and the branching.
   *
   * Deliberately not a structured error: the value of `tutorErrorMessage` is that it knows what an
   * exhausted ElevenLabs quota looks like on the wire, and an OpenAI 429 is a different sentence
   * with a different remedy. One function branching on both providers would recreate the exact bug
   * it was written to fix — a hint that is right sometimes and misleading the rest of the time.
   * See docs/2026-08-21-quota-outage-and-pause-panel.md.
   */
  onError(message: string): void;
  /**
   * The transport's OWN idea of the session id, which is ADVISORY and must never be stored.
   *
   * ElevenLabs derives it from the LiveKit room name and falls back to `room_<timestamp>`; OpenAI
   * mints an `rtc_…` call id at SDP exchange. Both are compared against the authoritative
   * `conversationId` and reported when they disagree — a tripwire, not a source.
   */
  onTransportId(id: string): void;
}

/**
 * What a transport reports, moment to moment. Read during render; changes constantly.
 */
export interface TutorTransportState {
  /**
   * The status to RENDER. Distinct from what `onStatus` reports, and deliberately so: on ElevenLabs
   * the two come from different places in the SDK and can legitimately disagree mid-transition. The
   * session renders this one and keeps the callback's value in a ref for the readers that live
   * outside a render.
   */
  status: TutorStatus;
  /** Is the tutor talking right now? Decides whether a pause has anything to interrupt. */
  isSpeaking: boolean;
  isMuted: boolean;
}

/**
 * What a transport can be TOLD to do.
 *
 * **Its identity must be stable for the life of the transport.** That is a hard requirement, not a
 * performance note: the session builds every one of its own controls on top of these, hands them out
 * through a context that promises to be "a stable object, safe in a dependency array", and screens
 * put `focusLesson` and `syncMeta` in effect dependency arrays on the strength of that promise. A
 * controls object that changed whenever `isSpeaking` flipped would re-run those effects several
 * times a minute for the whole of a lesson.
 *
 * That is the entire reason this is split from `TutorTransportState` rather than being one object —
 * the same split, for the same reason, that `lib/tutor-session.tsx` already makes between its state,
 * controls and active-session contexts.
 */
export interface TutorTransportControls {
  readonly capabilities: TutorCapabilities;

  /**
   * Mint a credential and connect — in two phases, and the seam between them is load-bearing.
   *
   * `onIdentified` is called with the descriptor **after** the credential is minted and **before**
   * the transport connects, and it is awaited. That is not a convenience; it is the only window in
   * which the session can legally do three things:
   *
   *   1. **Seed the row key.** From `onIdentified` onward `conversationId` is authoritative, whatever
   *      the transport later says its own id is. A turn can arrive on the first frame after connect,
   *      and a turn with no row key to file under is a lost transcript.
   *   2. **Spend the parked state.** The journal and the pause marker are cleared here — after the
   *      mint, so a REFUSED mint leaves them on disk, and before the connect, so the next focus
   *      cannot offer a resume into a conversation that has already been superseded.
   *   3. **Claim ownership**, so a callback that fires immediately is recognised as ours.
   *
   * Returning the descriptor instead would put all three after the connect, which is too late.
   *
   * Throws on a refused or unusable credential, and does NOT connect in that case — the session
   * treats that as "no conversation of ours exists", which is a different state from a connection
   * that came up and then failed.
   */
  start(
    request: TutorStartRequest,
    onIdentified: (descriptor: TutorSessionDescriptor) => Promise<void> | void,
  ): Promise<void>;
  /** Hang up. Synchronous and never behind a network call — see `end` in `lib/tutor-session.tsx`. */
  end(): void;

  /** Say something AS THE LEARNER, provoking a turn. The kickoff and the resume prompts use this. */
  say(text: string): void;
  /** Give the tutor context WITHOUT provoking a turn. */
  context(text: string): void;
  /**
   * Stop the current turn. Only meaningful when `capabilities.cancelTurn`; the session takes the
   * documented fallback otherwise rather than calling this and hoping.
   */
  cancelTurn(): void;
  /**
   * Reset the platform's turn timer. A no-op where `!capabilities.userActivity`, and the session
   * does not even schedule the timer in that case.
   */
  keepAlive(): void;

  setMicMuted(muted: boolean): void;
  /**
   * Silence the tutor's own audio locally, mid-word.
   *
   * **Returns whether it actually worked.** `false` means the tutor is STILL AUDIBLE, and the caller
   * is expected to say so rather than claim a silence it did not deliver. That signature is owed to
   * `lib/agent-audio.ts`, which reaches through a `protected` field to do this on ElevenLabs and
   * reports how many tracks it reached so a future SDK rename surfaces on screen instead of quietly
   * restoring an audible pause.
   */
  setOutputSilenced(silenced: boolean): boolean;
}

/** One provider, as the session sees it: volatile state beside stable controls. */
export interface TutorTransport {
  state: TutorTransportState;
  controls: TutorTransportControls;
}
