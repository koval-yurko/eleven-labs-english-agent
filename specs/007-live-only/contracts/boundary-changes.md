# Phase 1 Contracts: Boundary Surface After Removal

This feature exposes no *new* interfaces; it **removes** two boundary surfaces and trims one
field. The cross-subsystem contract remains the structured `LessonScript` (Constitution:
Generator ↔ Live Player communicate through the script). Below is the precise delta.

## Package boundary — `packages/contracts`

| File | Change | Detail |
|------|--------|--------|
| `src/qa.ts` | **DELETE** | Remove `QaExchange`, `QaTurn`, `CreateExchangeRequest`, `ExchangeListDTO`. `LiveSessionToken` (if still referenced by live-story) moves to / stays in `live-story.ts`; otherwise removed. |
| `src/index.ts` | **EDIT** | Drop `export * from "./qa"`. |
| `src/lesson.ts` | **EDIT** | Remove `audioDurationSeconds` from `LessonSummary`. Keep `LESSON_STATUSES` incl. `"ready"` (D1). |
| `src/lesson-script.ts` | **KEEP** | `LessonScript` unchanged — the only generation output (incl. `estimatedDurationSeconds`, `audioTags`). |
| `src/live-story.ts` | **KEEP** | `LessonPlan`, `LiveSession`, `SessionTurn`, `StartStoryToken` unchanged. |

## HTTP route surface — `apps/web/app/api`

### Removed (former access ⇒ 404, FR-009)
| Route | Method(s) | Was |
|-------|-----------|-----|
| `/api/lessons/[id]/live-session` | POST | 005 conversation-token mint for playback Q&A |
| `/api/lessons/[id]/exchanges` | GET, POST | 005 Q&A exchange list / create |
| Audio retrieval surface | GET | Signed-URL / `getAudioUrl` serving of `lesson-audio` objects (removed from the lessons service; no route serves audio) |

### Retained (live-story — unchanged, FR-006)
| Route | Method(s) | Purpose |
|-------|-----------|---------|
| `/api/lessons/[id]/live-story` | POST | Start live-story session (mints token via `lib/live-tutor/token.ts`) |
| `/api/lessons/[id]/live-story/turns` | POST | Persist session turns (durable transcript) |
| `/api/lessons/[id]/transcript` | GET | Read durable live-session transcript |

## Generator port boundary — `packages/generator`

| Symbol | Change |
|--------|--------|
| `RenderedAudio` (`adapters/types.ts`) | **REMOVE** — no audio artifact produced. |
| TTS adapter interface + `ElevenLabsTtsAdapter` + `MockTtsAdapter` | **REMOVE** — generation no longer renders. |
| `GenerateLessonResult.audio` (`index.ts`) | **REMOVE** — result is `{ script, metadata }`. |
| `generateLesson(...)` | **EDIT** — drop the render stage; return on valid script. |
| LLM adapter (`claude.ts` / `MockLlmAdapter`) + `derive-plan.ts` + `validate-coverage.ts` | **KEEP**. |
| Eval `ScorerKey` | **EDIT** — `"coverage" \| "two_voice" \| "story_not_definition"` (drop `"length"`). |

## Contract-test impact

- **Delete** `apps/web/tests/contract/qa-schema.test.ts`, `qa-api.test.ts` (005).
- **Keep** live-story contract tests; if `token.ts` import paths are touched, only update paths
  (we keep `token.ts` in place per D4, so no change expected).
- **Edit** `packages/generator/tests/eval/scorers.test.ts` — drop the length-scorer case and
  its import; keep coverage / two-voice / story-not-definition cases.
- **Add/adjust** a generation test asserting `generateLesson` returns a valid script and **no**
  `audio` field, and that the web generation bridge marks a lesson `ready` without any storage
  upload (SC-001).
