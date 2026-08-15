import { randomUUID } from "expo-crypto";

/**
 * The app's one source of client-minted ids.
 *
 * Every op in `@tutor/shared/sync-ops` takes a `newId` parameter rather than reaching for a global,
 * and this is what gets passed. Lesson and item ids are PRIMARY KEYS the learner keeps forever, and
 * both write paths upsert `ON CONFLICT (id) DO NOTHING` — so a collision with another owner's row
 * does not error, it silently makes the lesson or the word not exist.
 *
 * NOT `crypto.randomUUID()`, even though that works at runtime today. `@livekit/react-native`'s
 * `registerGlobals()` — a module-scope side effect of importing `@elevenlabs/react-native` in
 * `_layout.tsx` — installs a shim for it (`lib/module/index.js:91–108`) built on `Math.random()`.
 * Two problems with depending on that: it is ambient (the day the tutor import moves or is lazily
 * loaded, id minting breaks in a screen that never mentions LiveKit), and `Math.random()` carries far
 * less entropy than the 122 bits a v4 UUID claims.
 *
 * `expo-crypto` is first-party and backed by the platform CSPRNG. It is a native module, so adding it
 * was a rebuild rather than a JS reload.
 *
 * See docs/2026-08-13-expo-s5-lessons.md D49.
 */
export const newId = (): string => randomUUID();
