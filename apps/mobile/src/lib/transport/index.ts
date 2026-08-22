import type { TutorTransportHook } from "./types";
import { useElevenLabsTransport } from "./elevenlabs";
import { useOpenAiTransport } from "./openai";

export type { TutorTransportHook } from "./types";

/**
 * Which providers this build can run a lesson on.
 *
 * A registry rather than an import in the session, so adding one is a line here and a file beside
 * `elevenlabs.ts` — and so the set is STATIC. That matters more than it looks: every entry's hook is
 * called on every render (see `useTutorTransports` in `lib/tutor-session.tsx`), which the rules of
 * hooks require and which a runtime-conditional import would break.
 *
 * The ids are the vocabulary the rest of the app uses to name a provider. They are deliberately not
 * an enum in `@tutor/shared`: the server resolves a prompt VERSION, and whether a version implies a
 * provider is question 1 of §13 in docs/2026-08-22-openai-realtime-second-provider.md — undecided,
 * and not to be pre-empted by a type.
 */
export const TUTOR_PROVIDERS = {
  elevenlabs: useElevenLabsTransport,
  openai: useOpenAiTransport,
} as const satisfies Record<string, TutorTransportHook>;

export type TutorProviderId = keyof typeof TUTOR_PROVIDERS;

/**
 * The provider a session uses when nothing says otherwise.
 *
 * **This is the one line to flip to run every lesson on OpenAI.** It is a constant rather than a
 * setting on purpose: WHO chooses a provider — the learner, the prompt version, or the server — is
 * question 2 of §13 in docs/2026-08-22-openai-realtime-second-provider.md, it is a product decision,
 * and stage 3 is where it gets made. Until then a build runs one provider and this names which.
 */
export const DEFAULT_TUTOR_PROVIDER: TutorProviderId = "elevenlabs";
