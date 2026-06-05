# HTTP API Contract: Lesson Generation

**Feature**: 002-lesson-generation · Next.js App Router route handlers under `apps/web/app/api/lessons`.

All endpoints **require an authenticated Auth0 session** (FR-017); unauthenticated requests get `401`. Every endpoint operates only on the caller's own lessons — ownership enforced at the DB via RLS (FR-019, SC-005). All Supabase/provider access is server-side; no secrets reach the browser (Constitution V).

Conventions: JSON request/response. Errors use `{ "error": { "code": <string>, "message": <human-readable> } }`. Times are ISO-8601.

---

## POST /api/lessons — submit a list & start generation

Creates a lesson and kicks off asynchronous generation (research R6). Maps the input-guardrail requirements (FR-004–FR-007).

**Request**
```json
{ "items": ["break the ice", "spill the beans", "under the weather"] }
```
- `items`: array of raw strings (one entry per word/sentence/idiom), or a single newline-delimited string the server splits.

**Responses**

| Status | When | Body |
|---|---|---|
| `202 Accepted` | ≥1 teachable item; generation started | `LessonStatus` (status `pending`) + `skipped[]` report (FR-006) |
| `400 empty_input` | no entries at all (FR-004) | error: "Add at least one word, sentence, or idiom to generate a lesson." |
| `400 no_teachable_items` | entries present but none teachable (FR-007) | error: lists why nothing was teachable + revise prompt |
| `413 too_many_items` | teachable items exceed max (20, FR-005) | error includes `limit: 20`, `received: <n>`; learner trims (no silent drop) |
| `401 unauthenticated` | no session (FR-017) | error |

**202 body example**
```json
{
  "id": "9f1c…",
  "status": "pending",
  "requestedItemCount": 5,
  "acceptedItemCount": 3,
  "skipped": [
    { "rawText": "asdfgh", "reason": "gibberish" },
    { "rawText": "bonjour le monde", "reason": "non_english" }
  ],
  "createdAt": "2026-06-06T10:00:00Z"
}
```

---

## GET /api/lessons — list my lessons

Returns the caller's lessons, newest first, for the library (FR-020). Each item is disambiguated by source-item preview + creation time (research R10).

**200 body**
```json
{
  "lessons": [
    {
      "id": "9f1c…",
      "status": "ready",
      "itemPreview": ["break the ice", "spill the beans", "under the weather"],
      "acceptedItemCount": 3,
      "audioDurationSeconds": 412,
      "createdAt": "2026-06-06T10:00:00Z"
    }
  ]
}
```

---

## GET /api/lessons/{id} — lesson detail & status

Drives status display (FR-015) and the playback page. `404` if not found **or not owned** (no existence leak — SC-005).

**200 body (`ready`)**
```json
{
  "id": "9f1c…",
  "status": "ready",
  "acceptedItemCount": 3,
  "skipped": [],
  "items": [
    { "normalizedText": "break the ice", "itemType": "idiom", "covered": true }
  ],
  "audio": { "url": "<signed-url>", "durationSeconds": 412, "mimeType": "audio/mpeg" },
  "createdAt": "2026-06-06T10:00:00Z"
}
```

**Status variants**
- `pending` / `generating`: no `audio`; client subscribes/polls until terminal (FR-015, SC-008).
- `failed`: includes `errorReason` and `retryable: true` (FR-016).

---

## GET /api/lessons/{id}/audio — playback asset

Returns (or redirects to) a **short-lived signed URL** for the private audio object, minted server-side for the owner only (FR-014, FR-019). `404` if not owned; `409 not_ready` if the lesson is not `ready`.

---

## POST /api/lessons/{id}/retry — retry a failed generation

Re-runs generation for a `failed` lesson (FR-016). `409 not_failed` if the lesson is not in `failed`. Transitions `failed → generating`.

**202 body**: `LessonStatus` with status `generating`.

---

## Shared shapes

`LessonStatus`:
```json
{
  "id": "string",
  "status": "pending | generating | ready | failed",
  "requestedItemCount": 0,
  "acceptedItemCount": 0,
  "skipped": [{ "rawText": "string", "reason": "non_english | gibberish | not_discrete | duplicate" }],
  "errorReason": "string | null",
  "createdAt": "iso-8601"
}
```

All response/request bodies are defined as Zod schemas in `packages/contracts` (single source of truth, Constitution II). Contract tests in `apps/web/tests/contract` assert handlers conform to these shapes against mocked providers (Constitution Dev Workflow; research R11).
