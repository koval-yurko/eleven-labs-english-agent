# Route restructure: Lessons becomes Home, smoke test becomes `/demo`

**Date:** 2026-07-04
**Status:** Implemented 2026-07-04 (typecheck + lint + build green). Decisions taken: demo
files moved into `demo/`; `/lessons` kept as a `redirect("/")` stub.

## Goal

Promote the product surface to the root and demote the developer smoke test:

- Current **Home** (`/`) — the integration smoke test (Auth0 / Supabase / ElevenLabs /
  Claude status + write test + Ask Claude) → moves to **`/demo`**.
- Current **Lessons** (`/lessons`) — the learner's word-set list, the actual product entry
  point → becomes the new **Home** (`/`).

Lesson detail stays where it is (`/lessons/[id]`). Only the two index pages swap places.

## Current state (2026-07-04)

| Route | File | Role |
|-------|------|------|
| `/` | `src/app/page.tsx` | Integration smoke test (`HomePage`) |
| `/lessons` | `src/app/lessons/page.tsx` | Lessons list (`LessonsPage`) |
| `/lessons/[id]` | `src/app/lessons/[id]/page.tsx` | Single lesson + tutor + history |
| `/words` | `src/app/words/page.tsx` | Legacy redirect → `/lessons` |

## Proposed end state

| Route | File | Role |
|-------|------|------|
| `/` | `src/app/page.tsx` | **Lessons list** (new home) |
| `/demo` | `src/app/demo/page.tsx` | Integration smoke test |
| `/lessons/[id]` | `src/app/lessons/[id]/page.tsx` | Single lesson (unchanged) |
| `/lessons` | `src/app/lessons/page.tsx` | *(decision below — remove or keep as redirect)* |
| `/words` | `src/app/words/page.tsx` | Legacy redirect → `/` |

## File moves

1. **Smoke test → `/demo`.** Move `src/app/page.tsx` → `src/app/demo/page.tsx`.
   Component/content unchanged (rename `HomePage` → `DemoPage` for clarity). Relative
   imports go up one extra level: `../lib/...` → `../../lib/...`, and `./actions` /
   `./AskClaude` must resolve — those live in `src/app/`, so from `src/app/demo/` they
   become `../actions` and `../AskClaude` (or move `AskClaude.tsx` + the demo-only bits of
   `actions.ts` into `demo/` alongside it — see "Server actions" below).

2. **Lessons list → Home.** Move `src/app/lessons/page.tsx` → `src/app/page.tsx`.
   Its imports (`../../lib/...`, `./actions`) change: `../../lib/...` → `../lib/...`, and
   `createLessonAction` currently lives in `src/app/lessons/actions.ts`. From the new
   `src/app/page.tsx` that is `./lessons/actions` — keep the action file in place under
   `lessons/` (the detail page and `saveLessonSessionAction` still need it) and import it
   by its path.

## Cross-references to update

Found via `grep` for `href="/"`, `/lessons`, redirects, and `revalidatePath`:

- **`src/app/layout.tsx:56`** — header brand link `href="/"`. No change needed; it now
  correctly points to the new home (Lessons). ✔
- **`src/app/lessons/page.tsx:18`** (moving to `/`) — `<a href="/">← back</a>` would point
  to itself. **Remove** the "← back" link.
- **`src/app/lessons/[id]/page.tsx:79`** — `<a href="/lessons">← all lessons</a>`.
  Repoint to **`/`** (the list now lives at root).
- **`src/app/page.tsx:51`** (the smoke test, moving to `/demo`) — `<a href="/lessons">🎙️
  Lessons</a>`. Repoint to **`/`**. (Optionally drop it; the header already links home.)
- **`src/app/words/page.tsx:5`** — `redirect("/lessons")` → **`redirect("/")`**.
- **`src/app/lessons/actions.ts:29`** — `revalidatePath("/lessons")` in
  `createLessonAction`. The list is now at `/`, so change to **`revalidatePath("/")`**.
  `redirect(\`/lessons/${id}\`)` on the next line is unchanged (detail route stays).
- **`src/app/lessons/actions.ts:63`** — `revalidatePath(\`/lessons/${lesson.id}\`)`
  unchanged. ✔

## Server actions & `AskClaude`

`src/app/actions.ts` (`addPing`) and `src/app/AskClaude.tsx` are used **only** by the smoke
test. Two options:

- **Move them into `demo/`** next to `demo/page.tsx` (`demo/actions.ts`,
  `demo/AskClaude.tsx`). Cleanest — keeps the demo self-contained and the app root free of
  smoke-test-only files. Recommended.
- **Leave them in `src/app/`** and import across dirs. Fewer moves, but leaves smoke-test
  code sitting in the app root next to the real home page.

`src/app/lessons/actions.ts` stays under `lessons/` regardless — it is shared by the (new
root) list and the detail page.

## Decision: keep `/lessons` or not?

- **Remove `src/app/lessons/page.tsx` entirely.** Simplest; `/lessons` 404s. Any external
  bookmark to `/lessons` breaks.
- **Replace it with a redirect to `/`** (mirror the existing `/words` pattern:
  `export default function () { redirect("/"); }`). One tiny file; preserves old bookmarks
  and the `/words → /lessons → /` chain still lands home. **Recommended** — cheap and safe.

## Metadata / branding

`layout.tsx` metadata (title "Idiomatic — English tutor", PWA manifest, icons) is
route-agnostic and needs no change. The smoke-test page has no `metadata` export; the demo
page can optionally add `export const metadata = { title: "Demo — integration smoke test" }`.

## Risks / notes

- `page.tsx` (new home = Lessons) must keep `export const dynamic = "force-dynamic"` — the
  list is owner-scoped via cookies. It's already set in the current lessons page; carry it
  over.
- No routing config, middleware, or `next.config` route rules reference these paths
  (grep found only the in-component links above), so the blast radius is just the files
  listed here.
- Auth gating is unchanged: both pages already read `getOwnerId()` and render a
  signed-out state; swapping routes does not change the auth flow.

## Suggested implementation order

1. Move lessons list → `src/app/page.tsx`; fix its imports; drop the self-referential
   "← back" link; add `force-dynamic`.
2. Move smoke test → `src/app/demo/page.tsx` (+ `AskClaude.tsx`, `actions.ts`); fix
   imports; repoint its Lessons link to `/`.
3. Repoint `lessons/[id]` "← all lessons" → `/`; `words` redirect → `/`;
   `createLessonAction` revalidate → `/`.
4. Replace `src/app/lessons/page.tsx` with a `redirect("/")` (or delete).
5. `pnpm typecheck && pnpm lint && pnpm build`; click through `/`, `/lessons/[id]`,
   `/demo`, `/lessons`, `/words`.
</content>
</invoke>
