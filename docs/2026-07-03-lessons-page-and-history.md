# Lessons page — persisted word sets + per-lesson conversation history

_Date: 2026-07-03 — implementation note._

**Goal:** turn the throwaway `/words` page (paste words → one live voice session, nothing
saved) into a durable **Lessons** feature: a learner keeps a list of word sets they're
working on, creates new ones, and opens any lesson to both practice it out loud AND review
the history of previous tutor conversations they held over it.

## TL;DR

- `/words` is gone; it now `redirect()`s to `/lessons`. The home-page link points there too.
- **`/lessons`** — the learner's own word sets (newest first), each showing item count,
  conversation count, and a word preview — plus a "New lesson" form.
- **`/lessons/[id]`** — the lesson's words, the voice tutor (same version picker + live
  transcript as the old page), and a **History** section of past conversations, each
  expandable to its full transcript + ElevenLabs summary + duration.
- **Two migrations of state:** the old page held nothing server-side. Now a lesson is a row
  in `lessons` and every conversation is a row in `lesson_sessions`, owner-scoped exactly
  like `health_pings` (server stamps/filters `owner_id`, RLS is defense-in-depth).
- **History is written from two sides, upserted on `conversation_id`** so they never
  duplicate: the browser saves the bare transcript the instant the session ends (history
  appears immediately), and the ElevenLabs post-call webhook later enriches that same row
  with the richer transcript, summary, and duration.

## Schema — `supabase/migrations/0002_lessons.sql`

```text
lessons
  id           uuid pk
  owner_id     text            -- Auth0 sub
  title        text
  items        text[]          -- one word/phrase/sentence per element
  created_at   timestamptz

lesson_sessions
  id               uuid pk
  lesson_id        uuid  -> lessons(id) on delete cascade
  owner_id         text            -- copied from the lesson
  conversation_id  text unique     -- ElevenLabs conversation id (the upsert key)
  agent_version    text            -- tutor prompt version, e.g. words-1.1
  transcript       jsonb           -- [{role, text, timeInCallSecs?}]
  summary          text            -- ElevenLabs transcript_summary
  duration_secs    integer
  created_at       timestamptz
```

Both tables carry owner-only RLS policies (`owner_id = auth.jwt() ->> 'sub'`), matching the
baseline pattern. `conversation_id` is `unique` because it's the natural idempotency key the
two writers converge on. `on delete cascade` means deleting a lesson takes its history with
it. Applied to the live DB with `pnpm db:migrate` (skips 0001, applies 0002).

## Why two writers for one history row

The tutor LLM runs **inside** ElevenLabs convai, so the authoritative transcript only exists
in the post-call webhook payload — which arrives seconds-to-minutes after the call and can be
delayed or dropped. Waiting for it alone would make just-finished conversations invisible.
So:

1. **Browser save** (`saveLessonSessionAction`, called from `onDisconnect`): writes the
   transcript the client already accumulated via `onMessage`, keyed on the `conversationId`
   captured in `onConnect`. Fast, always happens, no summary/duration yet.
2. **Webhook enrich** (`persistLessonSession` in the elevenlabs-webhook route): upserts the
   same `conversation_id` with the fuller transcript (includes `time_in_call_secs`), the
   `transcript_summary`, and `call_duration_secs`.

`upsertLessonSession` only sets `summary`/`duration_secs` when provided, so whichever writer
lands second never clobbers fields it doesn't have. Ordering-independent by construction.

## Ownership across the trust boundary

The webhook has **no user session** — it's authenticated by the ElevenLabs HMAC signature,
not Auth0. The lesson id rides in on a new `lesson_id` **dynamic variable** stamped at
`startSession` (alongside the existing `app_env`). Dynamic variables come from the browser
and are therefore untrusted for ownership, so `persistLessonSession`:

- looks the lesson up by id via `getLessonById` (the **only** un-owner-scoped query in
  `src/lib/lessons.ts`, and it exists solely for this path), and
- takes `owner_id` **from the lesson row**, never from the payload.

The browser-side `saveLessonSessionAction` has the opposite guarantee: it has a session, so
it re-fetches the lesson with `getLesson(ownerId, lessonId)` and drops the write if the
lesson isn't the caller's. Ids from the client are never trusted for ownership on either side.

The webhook's existing env-routing (Prod relays to Dev; each instance handles only its own
`app_env`) is unchanged — persistence and LangSmith tracing both run only on the owning env.

## Files

- `supabase/migrations/0002_lessons.sql` — the two tables + RLS.
- `src/lib/tutor.ts` — client-safe shared bits: `TranscriptLine` type and the `KICKOFF_MESSAGE`
  constant (was inlined in the old component; now shared so the webhook filters it out of the
  stored transcript too).
- `src/lib/lessons.ts` — server-only data access: `listLessons` (with per-lesson session
  count via a `lesson_sessions(count)` embed), `getLesson`, `getLessonById`, `createLesson`,
  `listLessonSessions`, `upsertLessonSession`.
- `src/lib/agent-registry.ts` — added `versionForAgentId()` so the webhook can label a session
  with its prompt version from the payload's `agent_id` (retired versions included).
- `src/app/lessons/page.tsx` — the list + create form.
- `src/app/lessons/actions.ts` — `createLessonAction` (create → redirect into the lesson),
  `saveLessonSessionAction` (browser-side transcript save).
- `src/app/lessons/[id]/page.tsx` — one lesson: words, tutor, History (`<details>` per
  conversation).
- `src/app/lessons/[id]/LessonTutor.tsx` — the voice component, forked from the old
  `WordsTutor.tsx`: items now come from the lesson (no textarea), stamps `lesson_id`, and
  persists on disconnect via refs (the SDK callbacks close over first-render state) then
  `router.refresh()` to pull the new row into the server-rendered History.
- `src/app/words/page.tsx` — reduced to a `redirect("/lessons")`. `WordsTutor.tsx` deleted.
- `src/app/api/words-agent/elevenlabs-webhook/route.ts` — added `persistLessonSession`, run
  before tracing and independently best-effort (a persist failure doesn't skip the trace and
  vice-versa).

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm build` all clean.
- Data layer exercised against the live Supabase DB with a throwaway owner: create →
  owner-scoping rejection (another owner can't read the lesson) → client-save then
  webhook-enrich upsert converging on one row → session count in the list → cascade delete.
- Drove the real UI in Chrome (with a live Auth0 session): created a lesson (title fallback
  `"<first> +N more"` worked), saw it in the list, injected a simulated webhook session row,
  and confirmed History rendered the summary + full transcript. The simulated row was deleted
  afterward.

## Not done / possible follow-ups

- **No delete/edit-lesson UI.** Cascade delete is wired at the DB, but nothing in the app
  triggers it yet — deliberately, since delete is a destructive action worth designing
  around. Editing a lesson's word list is likewise absent.
- **`getLessonById` is intentionally un-scoped.** It's safe because it only reads `id`/
  `owner_id` and every write derived from it stamps that fetched `owner_id`. If more webhook
  paths appear, keep that invariant.
- **History has no pagination.** `listLessonSessions` returns all sessions for a lesson;
  fine at current volumes, revisit if a lesson accumulates hundreds of conversations.
- ElevenLabs native **Agent Versioning** could give free per-session history once >1 prompt is
  in play (see `docs/2026-06-27-agent-prompt-version-switching.md`), separate from this
  app-level history.
