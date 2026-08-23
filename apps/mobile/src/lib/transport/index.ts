import type { TutorProviderId } from "@tutor/shared/tutor/transport";

import type { TutorTransportHook } from "./types";
import { useElevenLabsTransport } from "./elevenlabs";
import { useOpenAiTransport } from "./openai";
import { useVapiTransport } from "./vapi";

export type { TutorTransportHook } from "./types";

/**
 * Which providers this build can run a lesson on.
 *
 * A registry rather than an import in the session, so adding one is a line here and a file beside
 * `elevenlabs.ts` — and so the set is STATIC. That matters more than it looks: every entry's hook is
 * called on every render (see `useTutorTransports` in `lib/tutor-session.tsx`), which the rules of
 * hooks require and which a runtime-conditional import would break.
 *
 * The keys are `TutorProviderId` from `@tutor/shared`, and the `satisfies` is doing real work: since
 * a prompt version names its provider (§13 Q1, settled 2026-08-22), the SERVER can hand this client a
 * provider it has no adapter for. Typing the registry against the shared union makes that a compile
 * error here rather than a lesson that will not start on a phone.
 */
export const TUTOR_PROVIDERS = {
  elevenlabs: useElevenLabsTransport,
  openai: useOpenAiTransport,
  // Registered, not implemented — and that is the `satisfies` above working as designed. Adding
  // "vapi" to the shared union broke this line until the phone had an answer, and the answer is
  // written down in ./vapi.ts rather than hidden by relaxing the type. Nothing routes here: the
  // server withholds every Vapi version from the picker (`CLIENT_READY` in
  // apps/web/src/lib/agent-registry.ts), so this is a second lock on a door that is already shut.
  vapi: useVapiTransport,
} as const satisfies Record<TutorProviderId, TutorTransportHook>;

/**
 * The provider a session uses when nothing says otherwise.
 *
 * A FALLBACK, not a setting. Since stage 3 the provider comes from the chosen prompt version —
 * picking a version IS picking a provider (§13 Q1/Q2) — and this covers the one window where no
 * version has been resolved yet: the first frames of a lesson screen, before `/api/v2/agent-versions`
 * has answered. A start in that window is rare and this keeps it working rather than refusing it.
 */
export const DEFAULT_TUTOR_PROVIDER: TutorProviderId = "elevenlabs";
