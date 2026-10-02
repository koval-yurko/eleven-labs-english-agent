import process from "node:process";

import {
  readCreditsExhausted,
  type CreditsExhausted,
} from "@tutor/shared/tutor/elevenlabs-credits";

/**
 * Is the ElevenLabs account the worker speaks with out of credits?
 *
 * Asked only AFTER a reply came back from the voice with no audio in it (`speech-watch.ts`), to
 * turn "the tutor went silent" into the sentence that names why. The decision is the shared
 * `readCreditsExhausted`, the same one the token routes use, and it keeps their rule: anything that
 * is not a clean "used up" — a non-200, a timeout, a key without `user_read`, no key at all — is
 * null, and the caller falls back to what it can actually see.
 */
const CREDITS_LOOKUP_MS = 2500;

export async function elevenLabsCreditsExhausted(): Promise<CreditsExhausted | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(CREDITS_LOOKUP_MS),
    });
    if (!res.ok) return null;
    return readCreditsExhausted(await res.json());
  } catch {
    return null;
  }
}
