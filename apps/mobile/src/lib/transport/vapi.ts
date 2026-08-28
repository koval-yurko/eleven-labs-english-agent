import { API_V2_ROUTES, isVapiTokenResponse, type VapiTokenRequest } from "@tutor/shared/api";
import type {
  TutorCapabilities,
  TutorEndReason,
  TutorStatus,
  TutorTransport,
  TutorTransportControls,
  TutorTransportEvents,
} from "@tutor/shared/tutor/transport";
import { useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "@/api";
import { applyVoiceLessonCategory, ensureStarted } from "@/lib/audio-session";
import { useAccessToken } from "@/lib/auth";
import { describeShim, installDailyWebRtcShim } from "@/lib/transport/daily-webrtc-shim";

/**
 * The Vapi transport.
 *
 * Vapi is an ORCHESTRATOR rather than a pipeline: the assistant — prompt, model, voice, turn-taking
 * plans — is a remote object that `pnpm sync:agents` provisions from `apps/web/src/agent/prompts/`.
 * So this adapter carries less configuration than either of its siblings and more lifecycle care,
 * because the SDK underneath it is Daily's and Daily has opinions about being reused.
 *
 * Everything non-obvious below was learned on a device by the path-A spike; see §12 of
 * docs/2026-08-27-vapi-third-voice-provider.md. Four things are worth knowing before reading:
 *
 *   1. **The SDK runs on LiveKit's WebRTC, not Daily's** (`apps/mobile/metro.config.js`), because
 *      only one `WebRTC.xcframework` can exist in the binary and the ElevenLabs SDK owns the choice.
 *      `daily-webrtc-shim.ts` supplies the four methods Daily's fork adds and LiveKit's lacks; it
 *      must run before the SDK module initialises, which is why the import below is lazy.
 *   2. **One client, ever.** Daily permits a single call object per process and throws
 *      `Duplicate DailyIframe instance are not allowed` otherwise. See `client()`.
 *   3. **`stop()` is async underneath a `void` signature.** The SDK awaits `call.destroy()` and only
 *      then emits `call-end`, so a restart that does not wait re-throws (2). See `teardown`.
 *   4. **The audio session is asserted here, twice.** Same finding as the OpenAI adapter: nothing
 *      else can, and the failure mode is silence rather than an error (`lib/audio-session.ts`).
 */

/**
 * What this provider can do, measured rather than hoped.
 *
 * `silenceOutput` is the one worth the reading it took: Vapi has no `setOutputVolume`, but its
 * client-inbound `control` message carries `mute-assistant` / `unmute-assistant`, which is exactly
 * the question the flag asks — can the learner stop hearing the tutor without ending the turn.
 *
 * The two `false`s are honest rather than provisional:
 *
 *   - **`cancelTurn`** — there is no "stop talking now". The nearest thing is a `say` with
 *     `interruptAssistantEnabled`, which REPLACES the current speech with other speech rather than
 *     ending it. A held pause therefore silences output instead, which is why (1) matters.
 *   - **`responseCorrection`** — Vapi reports `user-interrupted` and commits history through
 *     `conversation-update`, but hands over no `(previous, corrected)` pair. Reconstructing one
 *     means diffing committed history against what we already emitted; until that is built and
 *     measured, claiming the capability would make the session trust a callback that never fires.
 *
 * `userActivity` is `false` for a reason that is a property of the platform rather than of a
 * version: Vapi has no re-engage timer at all. Its only silence timer ENDS the call, and
 * `words-3.0` pins `silenceEndCallTimeoutSeconds: -1` so even that cannot fire. A held pause needs
 * nothing pinged.
 */
const CAPABILITIES: TutorCapabilities = {
  silenceOutput: true,
  userActivity: false,
  cancelTurn: false,
  responseCorrection: false,
};

/** The Vapi client surface this adapter uses. Narrowed on purpose — the SDK ships far more. */
interface VapiClient {
  on(event: string, cb: (payload?: unknown) => void): void;
  start(assistantId: string, overrides?: unknown): Promise<unknown>;
  stop(): void;
  send(message: unknown): void;
  setMuted(muted: boolean): void;
}

/** A `message` event, read defensively — nothing off the wire is trusted. */
type VapiMessage = {
  type?: string;
  role?: string;
  transcript?: string;
  transcriptType?: string;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Vapi's role vocabulary → ours.
 *
 * `assistant` is the tutor. Anything else that speaks is the learner: Vapi says `user` today, and
 * mapping unknown roles to `user` rather than dropping the line keeps a transcript complete if that
 * vocabulary ever grows.
 */
function toRole(role: unknown): "user" | "agent" {
  return role === "assistant" ? "agent" : "user";
}

export function useVapiTransport(events: TutorTransportEvents): TutorTransport {
  const accessToken = useAccessToken();

  const [status, setStatus] = useState<TutorStatus>("disconnected");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const clientRef = useRef<VapiClient | null>(null);
  /** True from the moment a call is asked for until `call-end` has actually fired. */
  const busyRef = useRef(false);
  /** Resolves the pending teardown when `call-end` arrives. See `teardown`. */
  const endedWaiterRef = useRef<(() => void) | null>(null);
  /**
   * Did WE hang up? This provider's answer to `TutorEndReason`.
   *
   * Better than OpenAI's, where the whole reason had to be synthesised: Vapi reports an
   * `endedReason` on `call-end`, so a line that dropped on its own can be told from one the platform
   * closed deliberately. This flag only has to cover the half Vapi cannot know — whether the LEARNER
   * asked to stop.
   */
  const hangingUpRef = useRef(false);
  /** `onEnd` fires exactly once per session; a teardown can produce several signals. */
  const endedRef = useRef(true);

  const eventsRef = useRef(events);
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    eventsRef.current = events;
    tokenRef.current = accessToken;
  });

  /**
   * Everything below is built once, on `[]`, and reads through refs.
   *
   * `TutorTransportControls` REQUIRES a permanently stable identity — screens put the session's
   * controls in effect dependency arrays on the strength of it.
   */
  const live = useRef({
    /**
     * The ONE client, created on first call.
     *
     * Every `new Vapi()` ends in `Daily.createCallObject()`, and Daily permits one per process. A
     * client per lesson therefore throws on the second lesson — which is not a hypothetical: this
     * hook is instantiated for every provider on every render by `useTutorTransports`, and the
     * screen it serves is mounted and unmounted freely.
     *
     * Reuse is what the SDK expects rather than a workaround: its `cleanup()` destroys the call
     * object and nulls it, and `start()` makes a new one. Listeners are registered on the INSTANCE,
     * so they survive across calls — and must therefore be registered exactly once, here.
     *
     * The `require` is lazy so the shim runs first (see the header) and so a module-scope failure
     * cannot take the whole route down before it paints.
     */
    client(token: string): VapiClient {
      if (clientRef.current) return clientRef.current;

      // Checked, not assumed. Under the New Architecture `NativeModules.WebRTCModule` can be an
      // interop proxy that accepts a write and discards it, and the symptom of a silently rejected
      // patch is Daily throwing `nativeUtils.setAudioMode is not a function` several frames later,
      // somewhere with no context. Failing here names the cause instead.
      const shim = installDailyWebRtcShim();
      if (!shim.moduleFound || shim.rejected.length > 0) {
        throw new Error(`Vapi cannot start on this build — ${describeShim(shim)}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy ON PURPOSE, see above
      const mod = require("@vapi-ai/react-native");
      const Vapi = (mod.default ?? mod) as new (key: string) => VapiClient;
      const client = new Vapi(token);
      clientRef.current = client;

      client.on("call-start", () => {
        setStatus("connected");
        eventsRef.current.onStatus("connected");
      });
      client.on("call-start-failed", (payload?: unknown) => {
        live.current.finish("error", str((payload as { msg?: string })?.msg) ?? "The call failed to start.");
      });
      client.on("call-end", (payload?: unknown) => {
        const reason = str((payload as { endedReason?: string })?.endedReason);
        live.current.finish(
          hangingUpRef.current ? "user" : reason && /error|failed/i.test(reason) ? "error" : "agent",
        );
      });
      client.on("speech-start", () => setIsSpeaking(true));
      client.on("speech-end", () => setIsSpeaking(false));
      client.on("error", (payload?: unknown) => {
        const message = str((payload as { message?: string })?.message) ?? "Vapi reported an error.";
        eventsRef.current.onError(message);
      });
      client.on("message", (raw?: unknown) => {
        const m = raw as VapiMessage | undefined;
        if (m?.type !== "transcript") return;
        // Vapi streams partials and then a `final` for the same utterance. Only the final one is a
        // TURN; emitting partials would write a line per word into the stored transcript.
        if (m.transcriptType && m.transcriptType !== "final") return;
        const text = str(m.transcript);
        if (!text) return;
        eventsRef.current.onTurn({ role: toRole(m.role), text });
      });
      return client;
    },

    /** One JSON control message to the assistant. A closed call is not an exception. */
    send(message: unknown): void {
      const client = clientRef.current;
      if (!client || !busyRef.current) return;
      try {
        client.send(message);
      } catch {
        // The call went away between the check and the send. Nothing to recover.
      }
    },

    /**
     * Report the end exactly once, and release anything waiting on it.
     *
     * `call-end` and `call-start-failed` can both arrive for one session, and `teardown` may be
     * waiting on the first of them.
     */
    finish(reason: TutorEndReason, error?: string): void {
      busyRef.current = false;
      endedWaiterRef.current?.();
      endedWaiterRef.current = null;
      setIsSpeaking(false);
      setStatus("disconnected");
      if (endedRef.current) return;
      endedRef.current = true;
      if (error) eventsRef.current.onError(error);
      eventsRef.current.onStatus("disconnected");
      eventsRef.current.onEnd(reason);
    },

    /**
     * End the call and WAIT for Daily to let go.
     *
     * `stop()` returns `void`, but the cleanup behind it awaits `call.destroy()` and only then emits
     * `call-end`. Starting the next lesson before that resolves throws
     * `Duplicate DailyIframe instance are not allowed` — the same error a second client causes, from
     * a completely different direction.
     *
     * The timeout is a safety valve, not an expectation: a teardown that never reports is worse
     * stuck than reported late, and `finish` is idempotent.
     */
    async teardown(): Promise<void> {
      const client = clientRef.current;
      if (!client || !busyRef.current) return;
      setStatus("disconnecting");
      eventsRef.current.onStatus("disconnecting");
      const ended = new Promise<void>((resolve) => {
        endedWaiterRef.current = resolve;
      });
      try {
        client.stop();
      } catch {
        live.current.finish("error", "The call could not be closed cleanly.");
        return;
      }
      await Promise.race([ended, new Promise<void>((r) => setTimeout(r, 5000))]);
      live.current.finish(hangingUpRef.current ? "user" : "agent");
    },
  });

  const controls = useMemo<TutorTransportControls>(
    () => ({
      capabilities: CAPABILITIES,

      start: async (request, onIdentified) => {
        const body: VapiTokenRequest = {
          lessonId: request.lessonId,
          // As data, never as prompt. The server renders the list; the assistant already holds the
          // text it goes into.
          items: request.items,
          ...(request.version ? { version: request.version } : {}),
        };
        const res = await apiFetch<unknown>(API_V2_ROUTES.vapiToken, tokenRef.current, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!isVapiTokenResponse(res)) {
          throw new Error("The server did not return a usable Vapi credential.");
        }

        // The seam — see `TutorTransportControls.start`. Nothing below may run before it: a turn can
        // arrive on the first frame after the connect and needs a row key to file under.
        await onIdentified({ conversationId: res.conversationId, version: res.version });

        endedRef.current = false;
        hangingUpRef.current = false;
        setStatus("connecting");
        eventsRef.current.onStatus("connecting");

        try {
          // Before the SDK opens anything. Without it AVAudioSession stays in `soloAmbient`, which
          // cannot render a WebRTC audio unit: every event flows and the lesson is SILENT.
          await ensureStarted();
          await applyVoiceLessonCategory();

          const client = live.current.client(res.token);
          busyRef.current = true;
          await client.start(res.assistantId, {
            // Prompt substitution only — this is what `{{items_list}}` becomes.
            variableValues: { items_list: res.itemsList },
            /**
             * Not prompt data: the identifiers the post-call webhook needs to find the row this
             * lesson already wrote (`api/v2/vapi/webhook`). Vapi echoes `metadata` back on the call
             * object, and it is the only channel that survives to the report.
             *
             * `conversationId` is OURS, minted by the token route, which is what makes the webhook
             * land on the same `lesson_sessions` row as the client's own write rather than creating
             * a second one. Vapi's call id could not do that job — it does not exist yet when the
             * row is first written.
             *
             * The server does not trust any of this for ownership; it reads that off the lesson row.
             */
            metadata: {
              lessonId: request.lessonId,
              conversationId: res.conversationId,
              version: res.version,
            },
          });
          // Again, now that the call owns a microphone — the category is asserted per track-state
          // change, which LiveKit does for its own Room and nothing does for Daily's call.
          await applyVoiceLessonCategory();
        } catch (e) {
          live.current.finish("error", e instanceof Error ? e.message : String(e));
          throw e;
        }
      },

      end: () => {
        hangingUpRef.current = true;
        void live.current.teardown();
      },

      /**
       * A hidden USER message that provokes a turn — the kickoff, and the resume.
       *
       * NOT `vapi.say()`, which makes the ASSISTANT speak the text given to it. The contract's `say`
       * is ElevenLabs' `sendUserMessage`: the session passes `KICKOFF_MESSAGE`, an instruction the
       * tutor should ACT on, and speaking it aloud would read the stage direction to the learner.
       *
       * `triggerResponseEnabled` defaults to true and is stated anyway, because the difference
       * between this and `context` below is exactly that flag.
       */
      say: (text) =>
        live.current.send({
          type: "add-message",
          message: { role: "user", content: text },
          triggerResponseEnabled: true,
        }),

      /** Grounding the tutor should know but must not answer. ElevenLabs' `sendContextualUpdate`. */
      context: (text) =>
        live.current.send({
          type: "add-message",
          message: { role: "system", content: text },
          triggerResponseEnabled: false,
        }),

      // Declared `false` in CAPABILITIES; the session never calls it. Present because the interface
      // requires it, and a body that silently did something else would be worse than one that does
      // nothing.
      cancelTurn: () => {},

      // Also unused: `userActivity` is false because this platform has no re-engage timer to reset.
      keepAlive: () => {},

      setMicMuted: (muted) => {
        const client = clientRef.current;
        if (!client) return;
        try {
          client.setMuted(muted);
          setIsMuted(muted);
        } catch {
          // A mute that could not be applied must not report itself as applied.
        }
      },

      /**
       * Silence the tutor without ending its turn — what a held pause needs on a provider with no
       * `cancelTurn`.
       *
       * Returns whether it was ATTEMPTED against a live call, following `setOutputSilenced`'s rule
       * that a caller must be able to tell. Vapi acknowledges nothing, so this is the honest limit
       * of what can be known from here.
       */
      setOutputSilenced: (silenced) => {
        if (!clientRef.current || !busyRef.current) return false;
        live.current.send({
          type: "control",
          control: silenced ? "mute-assistant" : "unmute-assistant",
        });
        return true;
      },
    }),
    [],
  );

  return { state: { status, isSpeaking, isMuted }, controls };
}
