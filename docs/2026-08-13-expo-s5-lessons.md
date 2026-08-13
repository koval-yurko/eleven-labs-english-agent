# S5 — lessons list and lesson detail · research

**Date:** created 2026-08-13 · **Status:** 🔲 **placeholder — not researched.**
**Enrich after: S4's gate is green.**

**Parents:** [build plan → S5](./2026-08-12-expo-build-plan.md) ·
[creation doc §3.3, §5, §6](./2026-08-12-expo-app-creation.md) ·
[S4 research](./2026-08-13-expo-s4-tutor-screen.md).

---

## Why this file is empty

S5 is the first stage that is mostly **CRUD UI**, and its shape is set by two things S4 decides in
practice rather than in theory: the data-fetching pattern (how a screen loads, caches and refetches
`/api/v2/*`) and D3, the component strategy, applied once for real. Deciding those here, before S4 has
built one screen, would be inventing conventions no code has tested.

## Already decided — do not re-derive

- **`POST /api/v2/sync/flush` with single-op batches**, not four bespoke REST mutations. One
  `createLesson`, one `addItems`, one `removeItem`, one `deleteLesson` through the op algebra in
  `packages/shared/src/sync-ops.ts` that is already property-checked. Keep it **even though v1 is
  online-only**: adding offline later then becomes a purely client-side change, and the server never
  learns the difference (creation doc §3.3).
- **The mirror is deferred, not cancelled** (D1). Do not build `MirrorStore` on SQLite at S5.
- **Server-side pattern:** validation + write live in `lib/`; the Server Action and the v2 route are
  both thin callers. `revalidatePath` stays in the web caller only. `after()` fast paths for the level
  and enrichment jobs **must** be duplicated into the v2 handlers, or words added from the phone wait
  for the next sweep (creation doc §3.2).
- **Positions continue from `max(existing.position) + 1`** — a removed item leaves a gap and reusing a
  position would collide (`CLAUDE.md`).
- Every write is `owner_id`-stamped in code; RLS is defense-in-depth.

## Inputs required from S4

- [ ] The data-fetching convention that emerged: plain `fetch` + hooks, a query library, or something
      else — and how auth headers are attached
- [ ] The navigation shape in `expo-router` (which routes exist, how the tutor is reached)
- [ ] D3 settled in practice: the component/styling approach S4 actually used
- [ ] Error/loading conventions S4 established

## Questions this research must answer

- [ ] `GET /api/v2/lessons` → `LessonListItem[]`: pagination or not, and what the list needs per row
- [ ] The `/api/v2/sync/flush` handler: how a single-op batch is validated, what `FlushResult` tells
      the client, and how a rejected op surfaces in the UI
- [ ] Optimistic UI **without** the mirror — what stands in for `planNewItems`' guarantee that the
      optimistic view and the queued intent cannot disagree?
- [ ] Delete-lesson semantics (words survive — see `docs/2026-07-17-delete-lesson-keep-words.md`) and
      the confirm-dialog pattern on native
- [ ] Add-word from a lesson: `resolve_words` is server-only, so what does the round-trip look like,
      and how does `clientDedupeKey` (deliberately weaker than `norm_key`) apply here?
- [ ] Refetch/invalidation after a write — the native client has no `revalidatePath`

## Gate

- [ ] Create a lesson, add items, remove an item, delete a lesson — **all reflected on the web app**

## Enrichment checklist

1. Copy in S4's conventions; do not invent new ones.
2. Re-read `packages/shared/src/sync-ops.ts` and `apps/web/src/lib/sync/engine.ts` for the op algebra
   and `applyOp`, then design the route around them rather than around the screens.
3. Flip the status line and update the build plan's Progress table.

## Sources to start from

- creation doc §3.2–3.3, §5, §6 · build plan S5
- In-repo: `packages/shared/src/sync-ops.ts`, `apps/web/src/lib/sync/engine.ts`,
  `apps/web/src/lib/lessons.ts`, `docs/2026-07-04-offline-support-and-sync.md`,
  `docs/2026-07-17-delete-lesson-keep-words.md`
