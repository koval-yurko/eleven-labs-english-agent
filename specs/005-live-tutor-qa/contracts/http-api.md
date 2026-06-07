# HTTP API Contracts: Live Tutor Q&A

**Feature**: 005-live-tutor-qa · Next.js App Router route handlers under `apps/web/app/api`.

All routes require an authenticated Auth0 session and are **owner-scoped**: the caller's Auth0 `sub` must own the lesson. Unauthenticated → `401`. Lesson not found **or** not owned → `404` (no existence leak, matching 002). Secrets (`ELEVENLABS_API_KEY`) never leave the server.

---

## POST `/api/lessons/{id}/live-session`

Mint a short-lived, owner-scoped credential for a realtime live-tutor session and return the per-session grounding context. The server fetches an ElevenLabs **conversation token** for the provisioned agent (`xi-api-key` server-side only), builds dynamic variables from the lesson's `LessonScript` + source items, and returns them.

**Preconditions**
- Lesson exists, is owned by the caller, and is `ready` (has a `script`). Non-ready → `409 Conflict`.
- Live tutor is configured (`ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID`) and the token mint succeeds. Otherwise → `503 Service Unavailable` with a body the client renders as the "live tutor unavailable" fallback (FR-017).

**Request body**: none (or `{ "currentPositionSeconds"?: number }` to seed the initial current-item context).

**200 Response** — `LiveSessionToken` (see `qa.schema.json`):
```json
{
  "agentId": "agent_xxx",
  "conversationToken": "<short-lived token>",
  "connectionType": "webrtc",
  "dynamicVariables": {
    "lesson_summary": "A lesson on 8 idioms about time...",
    "items_list": "1. break the ice; 2. piece of cake; ...",
    "current_item": "break the ice"
  }
}
```

**Errors**: `401` unauth · `404` not found/owned · `409` lesson not ready · `503` live tutor unavailable (configured-off or transient mint failure).

---

## POST `/api/lessons/{id}/exchanges`

Persist one completed Q&A exchange and its ordered turns (called **after** the exchange ends; never on the latency path). Body = `CreateExchangeRequest` (see `qa.schema.json`).

**Request body**:
```json
{
  "sourceItemId": "uuid-or-null",
  "interruptionPositionSeconds": 132.480,
  "elevenlabsConversationId": "conv_xxx",
  "turns": [
    { "role": "learner", "text": "What does 'break the ice' mean?", "turnIndex": 0 },
    { "role": "tutor", "text": "It means to ease tension when people first meet...", "turnIndex": 1 }
  ]
}
```

**Server behavior**
- Validates ownership of the lesson and that `sourceItemId` (if present) belongs to that lesson.
- Assigns `exchangeIndex` as the next index for the lesson (append-only ordering, FR-013).
- Stamps `owner_id` from the session on the exchange and every turn.

**201 Response** — the stored `QaExchange`:
```json
{
  "id": "uuid",
  "lessonId": "uuid",
  "sourceItemId": "uuid-or-null",
  "exchangeIndex": 0,
  "interruptionPositionSeconds": 132.480,
  "elevenlabsConversationId": "conv_xxx",
  "turns": [ { "role": "learner", "text": "...", "turnIndex": 0 }, { "role": "tutor", "text": "...", "turnIndex": 1 } ],
  "createdAt": "2026-06-07T10:00:00.000Z"
}
```

**Errors**: `400` invalid body (empty turns, blank text, negative position, `sourceItemId` not in lesson) · `401` · `404`.

---

## GET `/api/lessons/{id}/exchanges`

List the lesson's captured exchanges (owner-scoped), ordered by `exchangeIndex`, each with its turns. Supports the spec's "review what was asked/answered against which part of the lesson" (US3).

**200 Response**:
```json
{ "exchanges": [ /* QaExchange[] ordered by exchangeIndex */ ] }
```

**Errors**: `401` · `404`.

---

## Realtime session (not an app HTTP route)

The browser opens the realtime session directly with ElevenLabs using the `conversationToken` from `POST .../live-session`, via `@elevenlabs/react`. Turn-taking, **barge-in**, STT, and streaming TTS are owned by the platform (Principle IV). The app participates only through:
- `dynamicVariables` at `startSession` and `sendContextualUpdate(...)` when the current item changes (R4),
- `onMessage` to capture final transcripts (R9),
- `useConversationMode` to drive lesson pause/resume (R6),
- `onError` / connect-timeout to trigger the unavailability fallback (R8),
- `endSession()` on stop/navigate/lesson-end (R7).

No `xi-api-key` or agent secrets are ever sent to the browser.
