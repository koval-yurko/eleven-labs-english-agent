import type {
  TutorCapabilities,
  TutorTransport,
  TutorTransportEvents,
} from "@tutor/shared/tutor/transport";
import { useEffect, useMemo, useRef } from "react";

/**
 * Vapi — registered, NOT implemented.
 *
 * ## Why a placeholder exists at all
 *
 * `TUTOR_PROVIDERS` in ./index.ts is typed `satisfies Record<TutorProviderId, TutorTransportHook>`,
 * deliberately: adding a provider to the shared union has to stop the mobile build until someone
 * decides what the phone does about it. Adding `"vapi"` did exactly that, and this file is the
 * decision — *"the server can provision it; this build cannot run it"* — written down where the
 * compiler can see it, rather than by loosening the type to `Partial<…>` and letting a future
 * provider slip in unnoticed.
 *
 * ## Why it is unreachable rather than merely broken
 *
 * Nothing can route here. `activeVersions()` (apps/web/src/lib/agent-registry.ts) withholds every
 * Vapi version from the picker and the token routes via its `CLIENT_READY` set, so a lesson never
 * names this provider. The guard below is the second lock on the same door: if a build ever does
 * reach it, it fails loudly through `onError` — the path the tutor screen already renders — instead
 * of connecting to nothing and looking like silence.
 *
 * ## What a real adapter needs
 *
 * The mechanics are already proven on device by `src/app/spike-vapi.tsx` and §12.6 of
 * docs/2026-08-27-vapi-third-voice-provider.md: a call connects, is audible, survives a locked
 * screen, and coexists with an ElevenLabs lesson in both orderings. Turning that into a
 * `TutorTransport` is stage 3, and it needs, in rough order:
 *
 *   1. `lib/spike/daily-webrtc-shim.ts` promoted out of `lib/spike/` — an adapter cannot depend on a
 *      file labelled NEVER MERGE, and carrying that shim into production deserves its own review.
 *   2. A server route that mints the client credential (a public-scope JWT restricted to the
 *      assistant id, §6.2) and supplies `assistantOverrides.variableValues.items_list`, so the word
 *      list travels as data rather than as a prompt the client could rewrite.
 *   3. `capabilities` MEASURED, not assumed. `say` and `setMuted` exist on the SDK; `cancelTurn` and
 *      `setOutputSilenced` have no first-class method and are the two flags §5.1 leaves open.
 *   4. `onTurnCorrected` reconstructed by diffing `conversation-update` against what was already
 *      emitted — Vapi has no direct equivalent of the ElevenLabs correction callback (§5.2).
 *   5. `onUsage` left UNCALLED on purpose: Vapi bills minutes and dollars, not tokens, so the cost
 *      record comes from the `end-of-call-report` webhook instead (§8).
 */
const NOT_IMPLEMENTED =
  "The Vapi provider has no mobile adapter in this build. Pick another version.";

/** Everything false: nothing here can do anything. */
const CAPABILITIES: TutorCapabilities = {
  silenceOutput: false,
  userActivity: false,
  cancelTurn: false,
  responseCorrection: false,
};

export function useVapiTransport(events: TutorTransportEvents): TutorTransport {
  // The events object is recreated every render by the session; the ref keeps this hook's identity
  // stable without making the guard depend on a stale closure. Assigned in an effect rather than
  // during render, the same way `eventsRef` is in ./elevenlabs.ts — writing a ref while rendering is
  // a React Compiler error, and this file is not special enough to be the exception.
  const latest = useRef(events);
  useEffect(() => {
    latest.current = events;
  }, [events]);

  return useMemo<TutorTransport>(
    () => ({
      state: { status: "disconnected", isSpeaking: false, isMuted: false },
      controls: {
        capabilities: CAPABILITIES,
        async start() {
          latest.current.onError(NOT_IMPLEMENTED);
          latest.current.onEnd("error");
        },
        end() {},
        say() {},
        context() {},
        cancelTurn() {},
        keepAlive() {},
        setMicMuted() {},
        setOutputSilenced: () => false,
      },
    }),
    [],
  );
}
