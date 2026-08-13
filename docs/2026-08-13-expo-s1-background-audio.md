# S1 — background audio through a screen lock (B2) · research

**Date:** created 2026-08-13 · **Status:** 🔲 **placeholder — not researched.**
**Enrich after: S0's gate is green.** Do not research this ahead of time — see
[why](./2026-08-13-expo-s0-scaffold-testflight.md#how-the-stage-docs-work).

**Parents:** [build plan → S1](./2026-08-12-expo-build-plan.md) ·
[creation doc §9 B2](./2026-08-12-expo-app-creation.md) (the mechanism, researched) ·
[S0 research](./2026-08-13-expo-s0-scaffold-testflight.md) (the build pipeline this stage rides on).

---

## Why this file is empty

S1 is a **measurement**, and its research is mostly about how to measure honestly on a device you
cannot watch. The shape of that depends on facts S0 produces: how long a TestFlight round-trip takes
(five tests × one install each), how `EXPO_PUBLIC_*` values reach a cloud build now that `.env` never
does, and whether the local release-build loop works. Writing it before S0 would produce a procedure
against an imagined pipeline.

What is **already researched and must not be re-derived** is the mechanism itself — creation doc §9
B2: `UIBackgroundModes: ["audio"]` + `AVAudioSession` in `playAndRecord`, LiveKit's `registerGlobals()`
configuring the session, and [react-native-webrtc#1467](https://github.com/react-native-webrtc/react-native-webrtc/issues/1467)'s
finding that **track presence**, not audio content, is what keeps iOS from suspending after ~40s.
Expected answer: it holds. S1 exists because a mechanism being right does not prove our stack is.

## Inputs required from S0

- [ ] Bundle id (the **`-dev` variant** — S1 iterates on `APP_VARIANT=development`), EAS project id,
      working `eas.json`
- [ ] How to deliver `EXPO_PUBLIC_AGENT_ID` to a cloud build (EAS environment variables — `.env` is gitignored)
- [ ] Measured build → processing → install turnaround
- [ ] The confirmed local release-build command, for iteration between TestFlight uploads
- [ ] Whether `unstable_enablePackageExports` was needed
- [ ] Installed SDK / RN / React versions and the device's iOS version. **Expected: SDK 57 /
      RN 0.86 / React 19.2.3** (S0/D8, decided)

## Two dependency conflicts inherited from S0 — resolve these before anything else

Found while closing D8 on 2026-08-13 ([S0 §2](./2026-08-13-expo-s0-scaffold-testflight.md#2-decisions--settled-2026-08-13)), against the published peer ranges. Neither blocks
RN 0.86 by declared range; both are native-linkage risks, which is why they land here.

- [ ] **`@config-plugins/react-native-webrtc` has no SDK 57 release.** 15.0.1 is latest and peers
      `expo: ^56`; the line ships one major per SDK (14 → `^55`, 15 → `^56`). pnpm warns rather than
      fails and the plugin only patches iOS build settings, so it may simply work. **Check for a 16.x
      on the day this stage starts.** If `npx expo prebuild` breaks on it: wait for 16.x → override
      the peer → drop to SDK 56, in that order.
- [ ] **The ElevenLabs / LiveKit peer sets contradict each other.** `@elevenlabs/react-native@1.2.18`
      peers `@livekit/react-native: ^2.9.2` **and** `@livekit/react-native-webrtc: ^137.0.2`, but
      `@livekit/react-native@2.10.0+` requires webrtc `^144`. `^2.9.2` resolves to 2.12.0 and drags in
      144, violating ElevenLabs' own peer. `npx expo install` picks SDK-matched versions, not
      peer-consistent ones, so **install the jointly-satisfying set explicitly**:
      `@livekit/react-native@2.9.x` + `@livekit/react-native-webrtc@137.x` + `livekit-client@^2.15.4`.
      137 and 144 are different libwebrtc binaries — verify against the current ElevenLabs Expo
      example before assuming either side's range is merely stale.

## Questions this research must answer

- [ ] **S1a first:** does the stack even run? `expo-doctor` flags `@livekit/react-native` and
      `@livekit/react-native-webrtc` as _"Unsupported on New Architecture"_, which SDK 56+ enables by
      default ([livekit#255](https://github.com/livekit/client-sdk-react-native/issues/255), closed,
      unverified on RN 0.85 — and now **RN 0.86** per D8). Is the warning stale metadata, or real?
- [ ] If real: is `newArchEnabled: false` still available in SDK 57, or is pinning to an older SDK the
      only fallback? (The creation doc flags this as itself unverified — **check before relying on
      it**.)
- [ ] Which public agent to point at, and how to get one without touching our agent registry
- [ ] Exact **`app.config.ts`** block (S0/D7 replaced `app.json`): plugins,
      `NSMicrophoneUsageDescription`, `UIBackgroundModes: ["audio"]`
      (creation doc §7 has the draft — confirm against the current ElevenLabs Expo example)
- [ ] The suspension probe (build plan appendix A) — is a 1s `setInterval` vs wall-clock drift still
      the right instrument, and what is the noise floor on a real device?
- [ ] How to read results **after** unlocking: a timestamped scrollback on-screen, or logs shipped
      somewhere? A locked-screen test you cannot read is not a test.
- [ ] Does the mic-enable-on-`SignalConnected` behaviour (creation doc §9 B2) still hold in the
      shipped SDK version, i.e. is the published track really present for the whole session?
- [ ] What `AppState` transitions actually look like for lock vs app-switch vs Siri interruption
- [ ] If it fails: `setupIOSAudioManagement` with an explicit `playAndRecord` category — what exactly
      does that call look like, and does it conflict with `registerGlobals()`?

## Gate (fixed now, do not renegotiate later)

**S1a** — app launches; a **foreground** conversation completes with audio both directions and a
rendered transcript line. A crash here is a New Architecture / build problem, **not** a B2 result.

**S1b test A** passes when all four hold:

- [ ] `status` stayed `connected` throughout
- [ ] **`max drift` < 3s** ← the one that matters
- [ ] Agent audio audible **while the screen was locked**
- [ ] Transcript lines timestamped _during_ the locked window are present

Tests A–E, their methods and what each isolates: build plan → S1 → Gate S1b. Record the **number**,
not pass/fail — 0.4s and 2.9s both pass and say very different things about headroom. Results table:
build plan appendix B.

**A session still reporting `connected` after a 40-second lock is not a pass if drift shows 40s.**

## Escalation branch to cost, not to build

If audio is configured correctly and iOS still suspends: CallKit (`expo-callkit-telecom`). Larger
integration, its own App Review surface, buys the lock-screen call UI. **Re-estimate S4 before
committing** — this branch could turn 4.5–7 weeks into something longer and deserves an explicit
go/no-go. Do not build it preemptively.

"Passes only with the screen awake-but-dimmed" is **not a pass**.

## Enrichment checklist

1. Read S0's "What S0 hands to S1" section and copy the values in.
2. Verify the LiveKit/New-Arch status against current sources (issue #255, expo-doctor output on the
   real install) — the creation doc's note is from 2026-08-12 and this is the one fact most likely to
   have moved.
3. Confirm the `app.json` block against the official ElevenLabs Expo example at the version installed.
4. Write the measurement procedure: one section per test A–E, each with setup, what to watch, and how
   the result is read after unlocking.
5. Flip this file's status line to 🟡, then ✅ with the filled results table, and update the build
   plan's Progress table.

## Sources to start from

- creation doc §9 B2 and its source list · build plan S1 + appendices A and B
- [react-native-webrtc#1467](https://github.com/react-native-webrtc/react-native-webrtc/issues/1467)
- [livekit/client-sdk-react-native#255](https://github.com/livekit/client-sdk-react-native/issues/255)
- [ElevenLabs Expo integration guide](https://elevenlabs.io/docs/eleven-agents/guides/integrations/expo-react-native)
- Apple — background modes / `AVAudioSession` `playAndRecord`
