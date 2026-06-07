# HTTP API Contracts: Adaptive Live Story

**Feature**: 006-adaptive-live-story · Next.js App Router route handlers under `apps/web/app/api`.

All routes require an authenticated Auth0 session and are **owner-scoped**: the caller's Auth0 `sub` must own the lesson. Unauthenticated → `401`. Lesson not found **or** not owned → `404` (no existence leak, matching 002/005). Secrets (`ELEVENLABS_API_KEY`) never leave the server; the browser only ever receives a short-lived conversation token.

---

## POST `/api/lessons/{id}/live-story`

Start an adaptive live-narration session: derive the lesson plan, open a `LiveSession` row, mint an owner-scoped ElevenLabs **conversation token** for the provisioned story agent, and return the per-session grounding (R1/R2/R10).

**Preconditions**
- Lesson exists, is owned by the caller, and is `ready` (has a `script`). Non-ready → `409 Conflict`.
- Live story is configured (`ELEVENLABS_API_KEY` + `ELEVENLABS_STORY_AGENT_ID`) and the token mint succeeds. Otherwise → `503 Service Unavailable` with a body the client renders as the "live unavailable" panel — a clear message + **retry / try-later** (FR-026; research R7, no pre-render substitution).

**Request body**: none.

**200 Response** — `StartStoryToken` (see `live-story.schema.json`):
```json
{
  "sessionId": "uuid-of-opened-live-session",
  "agentId": "agent_story_xxx",
  "conversationToken": "<short-lived token>",
  "connectionType": "webrtc",
  "dynamicVariables": {
    "lesson_summary": "A lesson on 8 idioms about time...",
    "items_list": "1. break the ice; 2. piece of cake; ...",
    "beats_outline": "1. Two strangers meet (teaches: break the ice) ...",
    "target_minutes": "7",
    "scenario": "the original everyday setting"
  }
}
```

**Errors**: `401` unauth · `404` not found/owned · `409` lesson not ready · `503` live unavailable (configured-off or transient mint failure — body is the fallback message).

> Side effect: a `LiveSession` row is created with `status=active` before the token is returned, so turns can be persisted from the first `onMessage` and a dropped connection still leaves a (possibly empty) session that fills in as turns arrive (FR-027).

---

## POST `/api/lessons/{id}/live-story/turns`

Append one or more **finalized** turns to a session (called as `onMessage`/`onAgentResponseCorrection` fire — incremental, never on the speech/latency path). Body = `AppendTurnRequest` (see `live-story.schema.json`).

**Request body**:
```json
{
  "sessionId": "uuid",
  "turns": [
    { "role": "teacher", "kind": "narration", "text": "Two strangers waited at a bus stop...", "elevenTurnRef": "t12" },
    { "role": "learner", "kind": "question", "text": "What does 'break the ice' mean?" },
    { "role": "teacher", "kind": "answer", "text": "It means to ease the awkwardness when people first meet..." }
  ],
  "scenario": "space travel",
  "ended": false
}
```

**Server behavior**
- Validates ownership of the lesson and that the `sessionId` belongs to it.
- Assigns each turn the next `turnIndex` for the session (append-only ordering, FR-023); stamps `owner_id` from the session.
- **Barge-in correction (R5/R6)**: if a turn carries an `elevenTurnRef` matching an already-persisted teacher turn, its `text` is **updated in place** (the corrected text) rather than appended — keeping caption and transcript identical and never showing cut-off text (FR-020/FR-022/SC-008).
- If `scenario` is present, overwrite `live_sessions.scenario` (latest wins, FR-009).
- If `ended` is true, set `status=ended`, `ended_at=now()`.
- If `elevenlabsConversationId` is present and not yet set, persist it (reproducibility, Constitution III).

**201 Response** — the updated `LiveSession` (with its turns so far).

**Errors**: `400` invalid body (empty turns, blank text, role/kind inconsistency) · `401` · `404` (lesson or session not found/owned).

---

## GET `/api/lessons/{id}/transcript`

Review the lesson's durable live-session transcript(s) in a later session (FR-024). Owner-scoped; sessions ordered most-recent-first, each with its turns ordered by `turnIndex`.

**200 Response** — `TranscriptDTO`:
```json
{ "sessions": [ /* LiveSession[] with turns, most recent first */ ] }
```

**Errors**: `401` · `404`.

> No audio is ever returned (FR-025); the transcript text is the replayable record (FR-024).

---

## Realtime session (not an app HTTP route)

The browser opens the realtime session directly with ElevenLabs using the `conversationToken` from `POST .../live-story`, via `@elevenlabs/react`. Turn-taking, **barge-in**, VAD, STT, and streaming TTS are owned by the platform (Principle IV). The app participates only through:
- `dynamicVariables` at `startSession` (plan grounding, R2),
- **`clientTools`**: `advanceNarration`, `markItemTaught`, `setScenario`, `concludeLesson` — the narration/coverage/steering loop (R1/R3/R4; see `live-story.schema.json` `ClientToolContract`),
- `sendContextualUpdate(...)` to kick off narration and to re-pin a changed scenario every beat (R4),
- `onMessage` to capture finalized turns (teacher = `narration`/`answer`, learner = `question`) and append them (R5/R6),
- `onAgentResponseCorrection` to correct a barge-in-truncated teacher turn in caption AND transcript (R5),
- `onError` / connect-timeout to show the unavailable panel (clear message + retry; R7),
- `endSession()` on stop/navigate/conclude (bounds the realtime cost).

No `xi-api-key` or agent secrets are ever sent to the browser.
