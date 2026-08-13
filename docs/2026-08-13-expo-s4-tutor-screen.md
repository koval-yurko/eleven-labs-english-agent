# S4 — the tutor screen · research

**Date:** created 2026-08-13 · **Status:** 🔲 **placeholder — not researched.**
**Enrich after: S3's gate is green and the 🚩 go/no-go is recorded.**

**Parents:** [build plan → S4](./2026-08-12-expo-build-plan.md) ·
[creation doc §1, §4](./2026-08-12-expo-app-creation.md) ·
[S3 research](./2026-08-13-expo-s3-conversation-token.md).

---

## Why this file is empty

S4 is the first stage on the far side of the 🚩 gate, and its scope is contingent on what the three
blockers actually returned. If S1 went the CallKit route, half of this screen's lifecycle handling is
different. If S3 found the webhook reporting an id we did not expect, the save guard changes. And the
source it ports from — `apps/web/src/app/lessons/[id]/LessonTutor.tsx` — is a live file that is still
being edited on `master`; researching it now would describe a version that no longer exists by the
time the stage starts.

## Already decided — do not re-derive

- **The hooks port unchanged.** `@elevenlabs/react-native` re-exports `ConversationProvider` and every
  hook from `@elevenlabs/react` with an identical API, so `onConnect`, `onMessage`, `onDisconnect`,
  `onError`, `dynamicVariables`, `sendUserMessage`, `sendContextualUpdate`, `sendUserActivity` behave
  as on web (creation doc §4).
- **Everything from `@tutor/shared/tutor` is used as-is**: `KICKOFF_MESSAGE`, `RESUME_MESSAGE`,
  `HIDDEN_KICKOFF_MESSAGES`, `formatItemsList`, `formatResumeContext`, `sanitizeTranscript`. Copying
  any of it into the app is the one failure mode the workspace exists to prevent.
- **Do not port** (creation doc §1): `useKeepAwake` + `@zakj/no-sleep`, `useAudioHealth`, the
  `HIDE_GRACE_MS` visibility dance, `pagehide`/`freeze` beacons, the `"background"` pause card, or the
  `getUserMedia` pre-flight. Each is a workaround for a browser constraint that does not exist here.
- **Kept, repointed:** the session journal — crash/kill insurance now, not backgrounding insurance.
  `expo-sqlite` (or `AsyncStorage`) table of its own; the mirror is deferred (D1). The `"audio"` and
  `"recovered"` pause reasons survive; `"background"` does not.
- **No mic pre-flight** — the SDK's `AudioSession.configureAudio()` / `startAudioSession()` triggers
  the OS prompt, so a denial surfaces as a **session error**. The error copy must name that case.
- **`conversationId` comes from the token response, not the SDK** (B3).

## Inputs required from S3

- [ ] Working `POST /api/v2/words-agent/token` and `GET /api/v2/agent-versions`
- [ ] The verified answer to "which id does the webhook report", and the final save-guard rule
- [ ] Working `POST /api/v2/lessons/session`
- [ ] S1's verdict on lifecycle: what actually happens on lock, app-switch, and interruption — the
      pause-reason state machine is built from these, not from the web app's assumptions

## Questions this research must answer

- [ ] A current read of `LessonTutor.tsx` **at the time S4 starts**: which state machines exist, which
      are browser-specific, which port. (~504 lines today, roughly half of it deleted by §1.)
- [ ] `GET /api/v2/lessons/:id` shape: `LessonDetail` + sessions + item history in one response or
      three? What does the screen actually need on first paint?
- [ ] **`sendContextualUpdate` on WebRTC** — the resume flow is the one piece whose transport genuinely
      changed (LiveKit data channel, not the socket). Exercise it deliberately; do not assume.
- [ ] The interruption/recovery UX: what the SDK reports on an `AVAudioSession` interruption, and
      whether it recovers or wedges (S1 test E informs this)
- [ ] Session journal on `expo-sqlite`: schema, when it is written, when it is replayed, when cleared
- [ ] Transcript rendering performance — every line currently re-renders the whole screen. Do the split
      hooks (`useConversationControls` / `useConversationStatus` / `useConversationMode` /
      `useConversationInput`) earn their complexity here, or is that a later optimisation?
- [ ] D3 (component strategy) applied for the first time in anger — this screen is where it starts

## Gate

- [ ] A real lesson's words, spoken end to end, transcript saved to that lesson's history
- [ ] Resume after an interruption continues the lesson rather than restarting it

## Enrichment checklist

1. Copy in S1's lifecycle findings and S3's outputs.
2. Re-read `LessonTutor.tsx` and `apps/web/src/lib/tutor-session.ts` **fresh** and inventory what ports.
3. Write the state machine down before writing the screen; it is the one part that is not mechanical.
4. Flip the status line and update the build plan's Progress table.

## Sources to start from

- creation doc §1, §4 · build plan S4
- In-repo: `apps/web/src/app/lessons/[id]/LessonTutor.tsx`, `apps/web/src/lib/tutor-session.ts`,
  `packages/shared/src/tutor.ts`, `docs/2026-08-07-ios-keep-session-alive-foreground.md` (what is
  being deleted, and why it existed)
- [ElevenLabs React Native SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react-native)
