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
import { emit } from "@/lib/diagnostics";
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
 *   2. **One LIVE call, ever.** Daily permits a single call object per process and throws
 *      `Duplicate DailyIframe instance are not allowed` otherwise — but that object is made by
 *      `start()`, not by `new Vapi()`, so the constraint is on overlapping calls rather than on
 *      instances. The client is rebuilt per call because the SDK pins its credential at
 *      construction; see `client()`, which is where the second lesson of a process used to die.
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
/**
 * How long to wait for the agent to announce itself before connecting anyway.
 *
 * Measured at ~2.6s on device, so this is a backstop rather than a budget. It exists because the
 * alternative to guessing wrong is worse in one direction only: a lesson that reports `connected`
 * a beat early loses its opening line, while one that never reports it at all hangs on a spinner
 * with a live call behind it and no way for the learner to tell.
 */
const AGENT_READY_TIMEOUT_MS = 8000;

const CAPABILITIES: TutorCapabilities = {
  silenceOutput: true,
  userActivity: false,
  cancelTurn: false,
  responseCorrection: false,
  /**
   * The one capability here that is not about what the platform CAN do but about what it already
   * does without being asked. This assistant is provisioned
   * `assistant-speaks-first-with-model-generated-message` (`apps/web/src/agent/vapi-assistant.ts`),
   * so the tutor opens the lesson from the prompt at call start and a kickoff from us would only
   * open it a second time.
   */
  opensUnprompted: true,
};

/** The Vapi client surface this adapter uses. Narrowed on purpose — the SDK ships far more. */
interface VapiClient {
  on(event: string, cb: (payload?: unknown) => void): void;
  /** Inherited from `EventEmitter`. Used to mute a discarded instance — see `client()`. */
  removeAllListeners(): void;
  /** RESOLVES WITH `null` rather than throwing when it gives up. See `start` below. */
  start(assistantId: string, overrides?: unknown): Promise<unknown>;
  stop(): void;
  send(message: unknown): void;
  setMuted(muted: boolean): void;
}

/** A `message` event, read defensively — nothing off the wire is trusted. */
type VapiMessage = {
  type?: string;
  role?: string;
  status?: string;
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
  /** The last `call-start-progress` stage seen, so a failed start can say where it died. */
  const stageRef = useRef<string | null>(null);
  /** Have WE joined the Daily room? The first half of "connected" — see the `call-start` handler. */
  const joinedRef = useRef(false);
  /** Has the AGENT joined it? The half that decides whether a message sent now will be heard. */
  const readyRef = useRef(false);
  /** Fires `ready("timeout")` if the agent never announces itself. */
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
     * The client for THIS call — rebuilt every time, on purpose.
     *
     * This was once "the ONE client, created on first call", on the reasoning that every
     * `new Vapi()` ends in `Daily.createCallObject()`. It does not: in `@vapi-ai/react-native@0.3.0`
     * the constructor sets a base URL and a credential and nothing else, and the call object is
     * created inside `start()` (its `daily-call-object-creation` stage). Daily's one-per-process rule
     * is about a LIVE call object, and `teardown` below is what actually honours it.
     *
     * Reuse is what broke the SECOND lesson of a process. The constructor's only real work is
     * `apiClient.setSecurityData(apiToken)` against a MODULE-LEVEL singleton, and nothing else ever
     * writes it — so a reused client goes on presenting the FIRST call's JWT. Ours is minted per
     * lesson and restricted to one assistant (`allowedAssistantIds`, see the token route), so the
     * moment the learner switched version the credential still named the previous version's
     * assistant and `POST /call/web` was refused. What reaches the report is not an HTTP status but
     * `fetch failed: … The network connection was lost` — Expo's native fetch, six seconds in, on a
     * phone whose every other request that minute returned 200.
     *
     * The same staleness bites without a version switch: the JWT lives an hour, the client outlives
     * the app's foreground.
     *
     * Rebuilding clears the SDK's own per-call state too, and one piece of that matters — a start
     * that fails BEFORE the call object exists leaves `started` latched `true`, because `cleanup()`
     * returns early when there is nothing to destroy. Every later `start()` then hits the SDK's
     * `already-started` guard and returns `null` in silence. One failed start wedged the provider
     * until the app was relaunched.
     *
     * Listeners are registered on the INSTANCE, so they are registered here: once per instance,
     * which is now once per call.
     *
     * The `require` is lazy so the shim runs first (see the header) and so a module-scope failure
     * cannot take the whole route down before it paints.
     */
    client(token: string): VapiClient {
      /**
       * Let go of the previous instance before building its replacement.
       *
       * The listeners come off FIRST, and that ordering is the point: `stop()` runs the SDK's
       * `cleanup()`, which emits `call-end` if a call object is still alive, and `finish` would read
       * that as the end of the session now starting. After a clean `teardown` both lines are no-ops;
       * they are here for the paths that never got one.
       */
      const previous = clientRef.current;
      clientRef.current = null;
      if (previous) {
        try {
          previous.removeAllListeners();
          previous.stop();
        } catch {
          // The instance is being discarded either way.
        }
      }

      // Checked, not assumed. Under the New Architecture `NativeModules.WebRTCModule` can be an
      // interop proxy that accepts a write and discards it, and the symptom of a silently rejected
      // patch is Daily throwing `nativeUtils.setAudioMode is not a function` several frames later,
      // somewhere with no context. Failing here names the cause instead.
      const shim = installDailyWebRtcShim();
      /**
       * `describeShim` produces the one line that says which of the required natives were patched,
       * which were already there, and which the interop proxy silently refused. Until now it was
       * only ever seen INSIDE a thrown `Error` message — i.e. only when the shim had already
       * failed. Emitting it on every attempt is what makes the successful case comparable to the
       * failing one, which is the whole difference between "it broke" and "it broke on this build".
       */
      emit({
        level: shim.moduleFound && shim.rejected.length === 0 ? "info" : "error",
        code: "transport.shim",
        provider: "vapi",
        message: describeShim(shim),
        data: {
          moduleFound: shim.moduleFound,
          installed: shim.installed.length,
          present: shim.present.length,
          rejected: shim.rejected.length,
        },
      });
      if (!shim.moduleFound || shim.rejected.length > 0) {
        throw new Error(`Vapi cannot start on this build — ${describeShim(shim)}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy ON PURPOSE, see above
      const mod = require("@vapi-ai/react-native");
      const Vapi = (mod.default ?? mod) as new (key: string) => VapiClient;
      const client = new Vapi(token);
      clientRef.current = client;

      /**
       * `call-start` is emitted by TWO different things, and only the second one means what this
       * adapter needs it to mean.
       *
       * In `@vapi-ai/react-native@0.3.0` (`dist/vapi.js`), `onJoinedMeeting()` emits it when OUR
       * client joins the Daily room, and `onAppMessage()` emits it again when the bot broadcasts the
       * string `listening` — its pipeline is up and it is in the room. Roughly 2.6 seconds separate
       * them, which is why a debug report shows "call started" twice.
       *
       * Reporting `connected` on the first one is what cost the learner the tutor's opening line.
       * The session sends the kickoff the instant it sees `connected` (`lib/tutor-session.tsx`), and
       * `say` here is a Daily app-message — delivered to whoever is IN the room and queued for
       * nobody. Sent into an empty room it evaporates: no error, no return value, and the kickoff
       * latch has already flipped so nothing sends it again. The tutor then does exactly what the
       * prompt tells it to do without a kickoff, which is wait — and the learner has to open their
       * own lesson by saying "start".
       *
       * So the first one only starts the clock.
       */
      client.on("call-start", () => {
        if (joinedRef.current) {
          live.current.ready("agent-listening");
          return;
        }
        joinedRef.current = true;
        emit({
          level: "debug",
          code: "transport.connect",
          provider: "vapi",
          message: "joined the room, waiting for the agent",
        });
        readyTimerRef.current = setTimeout(
          () => live.current.ready("timeout"),
          AGENT_READY_TIMEOUT_MS,
        );
      });
      /**
       * The SDK narrates its own startup, and the narration is the only thing that says HOW FAR a
       * failed start got: `call-start-failed` hardcodes `stage: "unknown"`, because it is raised by
       * one `catch` around every stage. So the last stage seen is kept here and reported below —
       * `web-call-creation` failing is a refused credential or an unreachable Vapi; the Daily stages
       * failing are the room join. No extra timeline rows: this is read, not emitted.
       */
      client.on("call-start-progress", (payload?: unknown) => {
        const p = payload as { stage?: string; status?: string } | undefined;
        const stage = str(p?.stage);
        if (stage) stageRef.current = `${stage}:${str(p?.status) ?? "?"}`;
      });
      client.on("call-start-failed", (payload?: unknown) => {
        // NOT `msg` — this payload has never carried one. It is
        // `{ stage, totalDuration, error, errorStack, context }`, and reading the wrong key is why
        // every failed start in a debug report said only "The call failed to start."
        const p = payload as { error?: string; totalDuration?: number } | undefined;
        live.current.finish("error", str(p?.error) ?? "The call failed to start.", {
          stage: stageRef.current,
          ms: typeof p?.totalDuration === "number" ? p.totalDuration : null,
        });
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
        // No `errorType`/`code` to lift out: unlike ElevenLabs, this SDK hands over a message and
        // nothing else. That absence IS the finding — a report that shows a bare `transport.error`
        // on this provider is the reason to go and read the Vapi console.
        emit({ level: "error", code: "transport.error", provider: "vapi", message });
        eventsRef.current.onError(message);
      });
      client.on("message", (raw?: unknown) => {
        const m = raw as VapiMessage | undefined;
        /**
         * The other way the agent says it is here. `status-update` is subscribed on the assistant
         * (`clientMessages`, see `apps/web/src/agent/vapi-assistant.ts`), and `in-progress` means the
         * call is live at Vapi's end rather than just at Daily's.
         *
         * Two signals for one fact is deliberate: whichever arrives first is the one that counts, and
         * neither has to be the one that always works.
         */
        if (m?.type === "status-update") {
          if (m.status === "in-progress") live.current.ready("status-update");
          return;
        }
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
     * The agent is in the room and can hear us. THIS is `connected`, reported once per call.
     *
     * `via` is kept in the timeline because the three routes are not equally good news: an
     * `agent-listening` or `status-update` connect is the real thing, and a `timeout` connect says
     * the backstop fired — the call is up, but the opening line was sent on a hope. A report full of
     * the third kind is the signal that this gate needs a different signal, not a longer timer.
     */
    ready(via: string): void {
      if (readyRef.current || !busyRef.current) return;
      readyRef.current = true;
      if (readyTimerRef.current) {
        clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      }
      emit({
        level: via === "timeout" ? "warn" : "info",
        code: "transport.connected",
        provider: "vapi",
        message:
          via === "timeout"
            ? "the agent never announced itself — connecting anyway"
            : "call started",
        data: { via },
      });
      setStatus("connected");
      eventsRef.current.onStatus("connected");
    },

    /**
     * Report the end exactly once, and release anything waiting on it.
     *
     * `call-end` and `call-start-failed` can both arrive for one session, and `teardown` may be
     * waiting on the first of them.
     */
    finish(reason: TutorEndReason, error?: string, data?: Record<string, unknown>): void {
      busyRef.current = false;
      if (readyTimerRef.current) {
        clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      }
      endedWaiterRef.current?.();
      endedWaiterRef.current = null;
      setIsSpeaking(false);
      setStatus("disconnected");
      if (endedRef.current) return;
      endedRef.current = true;
      emit({
        level: reason === "error" ? "error" : "info",
        code: "transport.disconnect",
        provider: "vapi",
        message: error ?? `call ended (${reason})`,
        data: { reason, errored: Boolean(error), ...data },
      });
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
        // The preamble — see the ElevenLabs adapter for why every provider emits one before it can
        // fail.
        emit({
          level: "info",
          code: "transport.mint",
          provider: "vapi",
          message: "minting a Vapi credential",
          data: {
            route: API_V2_ROUTES.vapiToken,
            version: request.version,
            items: request.items.length,
            ...CAPABILITIES,
          },
        });
        let res: unknown;
        try {
          res = await apiFetch<unknown>(API_V2_ROUTES.vapiToken, tokenRef.current, {
            method: "POST",
            body: JSON.stringify(body),
          });
        } catch (e) {
          emit({
            level: "error",
            code: "transport.mint_failed",
            provider: "vapi",
            message: e instanceof Error ? e.message : String(e),
            data: { route: API_V2_ROUTES.vapiToken },
          });
          throw e;
        }
        if (!isVapiTokenResponse(res)) {
          emit({
            level: "error",
            code: "transport.mint_failed",
            provider: "vapi",
            message: "the token route answered with an unusable shape",
            data: { route: API_V2_ROUTES.vapiToken },
          });
          throw new Error("The server did not return a usable Vapi credential.");
        }
        // The assistant id, unlike the other two providers' agent ids, DOES reach the client — and
        // it is the join key into the Vapi console, so it is worth the line.
        emit({
          level: "info",
          code: "transport.connect",
          provider: "vapi",
          message: "credential minted, starting the call",
          data: {
            conversationId: res.conversationId,
            version: res.version,
            assistantId: res.assistantId,
          },
        });

        // The seam — see `TutorTransportControls.start`. Nothing below may run before it: a turn can
        // arrive on the first frame after the connect and needs a row key to file under.
        await onIdentified({ conversationId: res.conversationId, version: res.version });

        endedRef.current = false;
        hangingUpRef.current = false;
        stageRef.current = null;
        joinedRef.current = false;
        readyRef.current = false;
        // A new call object starts unmuted whatever the last one ended as, so the reported mute must
        // start from the same place — a stale `true` here shows the learner a muted mic that isn't.
        setIsMuted(false);
        setStatus("connecting");
        eventsRef.current.onStatus("connecting");

        try {
          // Before the SDK opens anything. Without it AVAudioSession stays in `soloAmbient`, which
          // cannot render a WebRTC audio unit: every event flows and the lesson is SILENT.
          await ensureStarted();
          await applyVoiceLessonCategory();

          const client = live.current.client(res.token);
          busyRef.current = true;
          const call = await client.start(res.assistantId, {
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
          /**
           * `start()` gives up by RESOLVING WITH `null`, not by throwing — both when the web call
           * could not be created and when its `already-started` latch refuses the attempt outright,
           * which emits nothing at all. Unchecked, a refusal is indistinguishable from a success: the
           * adapter waits in `connecting` for signals belonging to a call that was never made, with
           * no error and no timeout to end the wait.
           */
          if (!call) throw new Error("Vapi refused to start the call.");
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
