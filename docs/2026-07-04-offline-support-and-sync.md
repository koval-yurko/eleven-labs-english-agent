# Offline lessons — create & edit without a connection, sync when it returns

_Date: 2026-07-04 — research / design note. **Implemented 2026-07-05** — see "Final notes — as
implemented" at the end for what shipped and where it deviated from this plan._

**Goal:** let the learner **create a lesson** and **update an existing one** (add / remove
words & sentences) while offline, and have those changes **sync automatically** once the
network comes back — without losing edits or creating duplicates.

## TL;DR — recommendation

- **Scope offline to the lessons CRUD surface only.** Create lesson, add item, remove
  item, read a lesson you've already opened. The **voice tutor is online-only** (live
  ElevenLabs WebSocket + server-minted signed URL + Claude) — offline it shows a "reconnect
  to practice" state. This matches exactly what was asked.
- **Build a small local-first layer, don't adopt a heavyweight sync engine.** Three parts:
  a **service worker** (so the installed PWA opens at all offline), an **IndexedDB mirror**
  of the owner's lessons/items (so reads & edits work offline), and an **outbox** of queued
  mutations replayed on reconnect. Rejected alternatives (RxDB / ElectricSQL / PowerSync)
  below — they fight this app's "all data access is server-only, service-role, owner-scoped
  in code" security posture.
- **The linchpin is client-generated UUIDs.** Move id minting from Postgres
  (`gen_random_uuid()`) to the browser (`crypto.randomUUID()`) for lessons and items. Then
  an offline-created lesson has its *final* id immediately (`/lessons/[id]` works offline),
  and sync is a plain **idempotent upsert-by-id** with no id remapping. This is a one-line
  schema change (drop the default; accept a supplied id) — see below.
- **The existing schema is already a gift for sync.** `lesson_items` is append-only with
  soft-delete (`removed_at`). Add-item = insert-by-id (idempotent), remove-item = set
  `removed_at` (idempotent, last-write-wins trivially), create-lesson = insert-by-id. These
  ops are **commutative and re-runnable**, so replaying the outbox in any order converges.
  No CRDT, no merge engine needed.
- **On iOS (the clear install target here — all the apple-touch-icon work) there is NO
  Background Sync API.** The sync trigger must be **foreground**: flush the outbox on app
  open, on the `online` event, and on tab focus/visibility. Background Sync is a
  Chromium-only progressive enhancement layered on top, never the primary path.

## Current state (why offline is a real addition, not a flag)

Four things about today's architecture each independently break offline:

| # | Fact today | Why it blocks offline |
|---|---|---|
| 1 | Pages are React Server Components, `export const dynamic = "force-dynamic"` (`page.tsx`, `lessons/[id]/page.tsx`) | The **HTML itself** needs the network + a valid auth cookie to render. Offline, navigating to `/` or `/lessons/[id]` fails at the document fetch — the app won't even open. |
| 2 | All lesson data access is **server-only** — `src/lib/lessons.ts` uses the service-role Supabase client; the browser never sees lesson data except as rendered HTML | The browser has **no local copy** to read or edit offline. |
| 3 | Every mutation is a **Server Action** (`createLessonAction`, `addLessonItemsAction`, `removeLessonItemAction`) posted over the network | Server Actions are network round-trips. They simply **can't run offline**. |
| 4 | IDs are **DB-generated** (`gen_random_uuid()`), and create ends with `redirect(\`/lessons/${id}\`)` | An offline create has **no id** → nothing to redirect to, nothing to attach items to. |

What's *already* in place and helps:

- **PWA foundation exists but is inert for offline.** `app/manifest.ts` makes it installable
  (`display: standalone`), `layout.tsx` sets apple-touch icons and `appleWebApp`. But **there
  is no service worker anywhere** (`find` confirms: no `sw.ts`, no registration). So today the
  app is *installable* with *zero* offline capability — launch it offline and you get the
  browser's error page.
- **The soft-delete item model** (migration `0003`, doc `2026-07-04-lesson-editing…`) is
  unusually sync-friendly — see TL;DR.
- **Owner scoping is enforced in server code**, not trusted from the client. Offline writes
  will carry an owner id, but the server re-derives/validates it at sync time, so the trust
  boundary doesn't move.

## Approaches considered

### A. Turnkey local-first sync engine (RxDB, WatermelonDB, ElectricSQL, PowerSync, Legend-State)

Adopt a library that syncs Postgres ↔ client (IndexedDB / SQLite-wasm) with built-in
replication, reactivity, and conflict handling.

- ✅ Solves the hard parts (replication, offline reads, conflict) out of the box.
- ❌ **Fights this app's security model.** ElectricSQL / PowerSync want the client to talk to
  a replication endpoint / Postgres directly; today *nothing* client-side touches Supabase —
  reads go through the service-role key server-side and owner scoping lives in code. Adopting
  one means re-homing the trust boundary (client-side RLS, new auth wiring, exposed anon keys).
- ❌ **Disproportionate.** The offline surface is create/add/remove on word lists of ≤50
  items. A replication engine + its bundle + its operational surface is a lot of machinery
  for that.
- Verdict: **rejected for now.** Revisit only if offline scope grows to sessions/transcripts
  and multi-device real-time.

### B. Rely on `supabase-js` offline

- ❌ Non-starter: `supabase-js` has no offline queue or local cache, and it's server-only here
  anyway. Nothing to build on.

### C. Bespoke local-first layer — service worker + IndexedDB mirror + outbox — **recommended**

Build the minimum that fits the existing shape:

1. **Service worker** precaches the app shell + Next static chunks and serves a
   client-rendered shell offline, with an offline fallback route.
2. **IndexedDB mirror** of the owner's `lessons` + `lesson_items`, seeded from the server when
   online, read directly by the UI (so reads/edits work offline and feel instant).
3. **Outbox**: every mutation appends an intent record and optimistically updates the mirror;
   a **sync engine** replays the outbox to the server on reconnect.

- ✅ **Keeps writes going through owner-scoped server code** — the outbox flushes to a
  `flushOutbox(ops[])` **Server Action** (owner re-derived from the session), so the trust
  boundary is unchanged.
- ✅ Incremental; no new backend infra; small given the commutative schema.
- ❌ You write the sync/reconcile loop yourself — but it's genuinely small here (idempotent
  upserts, LWW on two fields). Dexie.js can carry the IndexedDB + reactivity weight.
- Verdict: **recommended, staged** (order at the end).

### D. Minimal "capture & forward" — queue writes only, no offline reads/render

Queue failed writes in `localStorage`, replay on reconnect; don't attempt offline rendering.

- ✅ Smallest possible change.
- ❌ **Insufficient for the ask.** "Update the current lesson" means *seeing* it offline, but
  with `force-dynamic` the page won't even load offline (fact #1). Without an offline read
  path you can queue a blind "remove item X" but can't show the user what they're editing.
- Verdict: rejected as the endpoint; it's essentially a degenerate case of C without the
  mirror.

## Recommended design (option C, in detail)

### 1. Client-generated UUIDs — the enabling schema change

Today `createLesson` inserts and lets Postgres mint the id, then item rows reference it. For
offline, the **client** must mint ids so an entity is fully-formed before it ever reaches the
server.

**No migration is required.** `gen_random_uuid()` stays as the column default and keeps working
for any code path that omits an id; the change is *purely application-side* — the app **always
supplies `id`** (minted with `crypto.randomUUID()`) for lessons and items, and the sync/create
paths **upsert on the primary key** (`onConflict: "id"`) instead of a plain insert. There is no
`0004` migration; the schema already accepts a supplied `id`.

No destructive migration is needed — `gen_random_uuid()` can remain the *default*; the change
is that the app **always supplies `id`** for lessons and items and the sync path **upserts on
the primary key** (`onConflict: "id"`) instead of plain insert. An offline-minted
`crypto.randomUUID()` collides with nothing and becomes the permanent id — no post-sync
remapping of `/lessons/[clientId]` → `/lessons/[serverId]`.

> Add one bookkeeping column to make LWW and idempotency crisp:
> `updated_at timestamptz not null default now()` already exists on `lessons` (migration
> 0003). Add the same to `lesson_items` if title/text LWW is ever needed; for now items only
> ever go active→removed, so `removed_at` alone suffices.

### 2. Service worker (make the PWA open offline)

**Implemented as a hand-rolled `public/sw.js`** (see resolved open question — `@serwist/next`'s
stable webpack plugin doesn't support Next 16's default Turbopack build). Scope is `/` (the
script sits at the origin root).

- **Runtime caching, no build-time precache manifest needed.** Next's `/_next/static/*` assets
  are content-hashed and immutable, so a **cache-first** strategy caches them naturally as they
  load — no hashed-chunk manifest to generate. The only precached entry is the offline fallback
  route (`/offline`), added in the SW `install` step.
- **Navigations are network-first with an offline fallback to `/offline`** — and, in this SW
  stage, authenticated HTML pages are deliberately **not** cached, so a shared device can't
  surface one learner's server-rendered page to the next. Real offline *content* arrives with
  the IndexedDB mirror + client islands (later stage); this stage just makes the app **open**
  offline instead of showing the browser error page.
- **Auth interaction:** `src/proxy.ts` redirects unauthenticated *page* requests to
  `/auth/login`. `/manifest.webmanifest` and the PWA icons are already allow-listed past the
  gate — extend the same treatment to **`/sw.js`** and **`/offline`** so the SW script and the
  offline shell stay publicly reachable. Owner scoping still happens at **sync time** on the
  server.
- **Registration:** a tiny client component (`ServiceWorkerRegister`) calls
  `navigator.serviceWorker.register("/sw.js")` on `load`, **production-only**, mounted in
  `layout.tsx`.

### 3. Local read path — an IndexedDB-backed client island

The tension with fact #1 (RSC + `force-dynamic`) is resolved **incrementally**:

- **Online, first paint:** server renders as today, and seeds an IndexedDB mirror with the
  payload it just rendered (lessons list, the open lesson's items).
- **Edits & offline:** the "Words in this lesson" / "New lesson" / lessons-list surfaces
  become **client islands** that read from and write to the IndexedDB mirror (via a small
  data hook, e.g. Dexie's live queries). The mirror — not the server HTML — is authoritative
  for what the user sees while editing.
- **End state (optional):** promote `/` and `/lessons/[id]` to an app-shell model the SW
  always serves from cache, with the server demoted to a pure sync API. Bigger rewrite of the
  read path; not required for v1.

### 4. Write path — outbox + optimistic mirror

Each of the three mutations (create lesson, add items, remove item):

1. Mints ids client-side where needed (`crypto.randomUUID()`).
2. **Optimistically** updates the IndexedDB mirror (UI reflects it instantly, online or off).
3. Appends an **outbox** record: `{ id, op, entityId, payload, owner, clientSeq, createdAt }`.

IndexedDB stores (Dexie): `lessons`, `lesson_items`, `outbox`, and a small `meta`
(last-pulled cursor, owner sub).

### 5. Sync engine — replay on reconnect

Trigger flush on: **app open**, the `window` **`online`** event, and **`visibilitychange`/
focus**. (Background Sync as enhancement — see iOS note.)

Flush = call the **`flushOutbox(ops[])` Server Action** with the outbox in `clientSeq` order
(one call, whole batch — no new REST route; see resolved open question). The action:

- Re-derives the owner from the session (never trusts the payload's owner — same posture as
  `getLessonById` taking owner *from the row*).
- Applies each op **in order** as an **idempotent upsert-by-id** (create/add) or
  **soft-delete set** (remove), reusing the `src/lib/lessons.ts` functions. Re-running a
  delivered op is a no-op, so a partial flush that half-succeeds is safe to retry wholesale.
- Is **non-redirecting** (unlike the online `createLessonAction`) and returns a per-op
  `{ id, ok }` result so the client can clear exactly the applied outbox records and keep the
  rest for the next flush.

Then **pull**: fetch lessons/items updated since the client's cursor, merge into the mirror.

### 6. Conflict resolution (why it's easy here)

Single user, possibly two devices. The op set is near-commutative:

| Op | Merge rule | Why it's safe |
|---|---|---|
| create lesson | insert-if-absent by id | client UUID unique; re-send is a no-op |
| add item | insert-if-absent by id | append-only; re-send is a no-op |
| remove item | set `removed_at` (LWW, or `min`) | idempotent; order-independent |
| lesson title | LWW by `updated_at` | only real conflict; acceptable for a learning app |

The only genuine conflict is two devices editing the **same lesson's title** concurrently →
last-write-wins per field. Item add/remove across devices simply **union** (add) and
**tombstone** (remove) — no lost work. Worth stating explicitly in the doc so the LWW choice
is a decision, not an accident.

## The iOS reality check (call this out loudly)

This app is clearly aimed at iOS install (apple-touch-icon, `appleWebApp`, `viewportFit:
cover`). iOS constrains the design
([MagicBell PWA iOS limits](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide),
[caniuse: Background Sync](https://caniuse.com/background-sync),
[whatpwacando: Background Sync](https://whatpwacando.today/background-sync/)):

- **No Background Sync / Periodic Sync / Background Fetch on iOS**, with no announced timeline
  (both are Chromium-only). ⇒ **Sync must be foreground-triggered.** The `online`-event +
  app-open + focus flush *is* the primary path, not a fallback.
- **IndexedDB works but has a history of instability on iOS** (transaction hangs, rare
  corruption around OS updates). ⇒ Treat the outbox as the source of truth for unsynced
  intent, keep records small, and make replay tolerant of a partially-lost mirror (the server
  pull can always rebuild the mirror; only the *outbox* is irreplaceable).
- **Aggressive storage eviction** (~7 days idle, ~50 MB budget). ⇒ Call
  `navigator.storage.persist()` after install; keep the mirror to the owner's lessons only,
  not transcripts.
- **Installed (Add to Home Screen) PWAs get more durable storage** than tab-only sites — nudge
  the user to install, which the manifest already enables.

## What stays online-only (explicit non-goals)

- **The voice tutor** — live ElevenLabs WebSocket, server-minted signed URL, Claude. Offline,
  `LessonTutor` should detect `!navigator.onLine` and show "Practice needs a connection"
  instead of the Start button.
- **Session history & transcripts** — read-only server data; fine to show a cached copy of
  already-loaded sessions, but not part of the offline *edit* goal. `saveLessonSessionAction`
  could later be outboxed too, but a transcript is only produced by an (online) live call, so
  it's a non-issue for v1.
- **Agent registry / sync:agents** — build-time concern, irrelevant offline.

## Suggested implementation order

1. **Service worker + offline shell** (hand-rolled `public/sw.js`): app opens offline, `/offline`
   fallback route, `ServiceWorkerRegister` in `layout.tsx`, allow-list `/sw.js` + `/offline`
   past the auth gate. *Ship this alone first* — it's independently useful (installable app that
   launches offline) and de-risks the PWA plumbing before any data work.
2. **Client UUIDs**: app always supplies `id` for lessons/items; sync path upserts on PK.
   Pure server/data-layer change, no behavior change online.
3. **IndexedDB mirror + read islands** (Dexie): seed from server payload online; lessons list
   and lesson page read the mirror. Reads now work offline.
4. **Outbox + optimistic writes**: the three mutations write mirror + outbox; UI is optimistic.
5. **Sync engine**: `flushOutbox(ops[])` Server Action (owner-scoped, idempotent upserts) +
   foreground flush triggers + pull-since-cursor merge. Add Background Sync as a Chromium-only
   enhancement last.
6. **Verify** per the usual bar: typecheck/lint/build, then a live offline pass in an
   *installed iOS PWA and* desktop Chrome — create a lesson offline → add/remove words offline
   → kill and relaunch offline (data still there) → go online → confirm one idempotent sync,
   no duplicates, correct `/lessons/[id]`, and a second device converges.

## Open questions — resolved (2026-07-04)

- **Do we need `/api/sync`, or reuse Server Actions?** → **Reuse Server Actions.** The reason
  `/api/sync` looked attractive was *one round-trip for the whole outbox* — but a Server Action
  can take arbitrary serializable args, so a single **`flushOutbox(ops[])`** action batches the
  entire outbox in one call too. Reusing an action keeps the existing trust posture (owner
  re-derived from the session, same as every other action), reuses the owner-scoped data-layer
  functions, and adds no REST route to parse/version. **All** lesson writes (online and offline)
  now flow through the mirror + outbox → the single **JSON-arg, idempotent, non-redirecting
  `flushOutbox` action**; the former FormData actions (`createLessonAction` /
  `addLessonItemsAction` / `removeLessonItemAction`) were removed as this path supersedes them.
  See §5 (rewritten).
- **Offline auth / shared device.** → **Namespace the mirror by owner `sub`, clear on owner
  change.** A shared device must not leak one learner's offline lessons to the next. A single
  `idiomatic-mirror` DB carries an `owner` meta row; logging in as a different `sub` wipes
  lessons/items/outbox before seeding (`ensureOwner`) — more robust across browsers (iOS Safari)
  than enumerating/naming per-owner DBs.
- **Conflict policy.** → **LWW per field** for the one real conflict (lesson title), union/
  tombstone for items. Fine for single-user; revisit if collaboration ever appears.
- **How much history offline?** → **Mirror only *active* lessons + items**, not
  transcripts/sessions (keeps under iOS's storage budget). Session history stays online-read.
- **Serwist vs. hand-rolled SW.** → **Hand-rolled minimal SW** (`public/sw.js`). Checked at
  implementation time: `@serwist/next`'s stable path is a **webpack plugin that explicitly does
  not support Turbopack**, and Next 16 defaults to Turbopack for `build` — so the plugin would
  silently skip generating the SW unless we force `--webpack` (losing Turbopack for the whole
  app) or adopt the newer/heavier `@serwist/turbopack` / configurator mode. Our precache surface
  is tiny (offline fallback + immutable `/_next/static` assets, cached at runtime — Next chunks
  are content-hashed so cache-first is safe), so a dependency-free static `public/sw.js` is the
  lower-risk, bundler-agnostic choice. Revisit Serwist only if precaching grows complex.

## Final notes — as implemented (2026-07-05)

Built and verified end-to-end (typecheck/lint/build + a real prod build driven in Chrome). All
seven stages shipped, including the "optional end-state" app-shell. Deviations from the plan
above, worth knowing:

- **App-shell promotion (§3 end-state) — done, but lighter than "demote every page."** Instead of
  making `/` and `/lessons/[id]` data-free shells, **`/offline` itself became a URL-aware client
  app-shell** (`src/app/OfflineApp.tsx`): the SW already serves cached `/offline` for any failed
  navigation, so the shell reads `location.pathname` + the mirror and renders the list or a lesson
  (title + editable words). **Online pages are unchanged** (still SSR-with-data, uncached) — no
  cross-user HTML-cache leak, and no online first-paint regression.
- **SW precaches the shell's chunks at install (`precacheShell`, cache `v2`).** Opportunistic
  cache-first raced and missed one hydration-critical chunk → the offline shell couldn't upgrade
  past its static notice. Install now fetches `/offline` and `cache.addAll`s every
  `/_next/static` asset it references. `SyncProvider` also `router.prefetch("/offline")`s to warm
  it. (So the SW *does* effectively precache the shell — the §2 "no precache manifest" note holds
  for page assets generally, but the shell is explicitly precached.)
- **"Pull" is `router.refresh()`, not a cursor.** §5's pull-since-cursor was overkill: after a
  successful flush the client calls `router.refresh()`, the RSC re-renders, and the read islands
  **reseed** the mirror (reconciling per-lesson). The reseed **honors pending outbox ops**
  (`seedLessonItems` keeps not-yet-synced local adds, doesn't resurrect local removes) so a
  refresh can't clobber unsynced edits. No `meta` cursor is used.
- **Owner isolation = single DB + `owner` meta wipe**, not per-owner DB names (see resolved Q).
  `ensureOwner` only runs when a verified `sub` is available (online, via the server-rendered
  props); offline it trusts the existing mirror owner (you can't log in as someone else offline).
- **LWW-on-title is designed but not exercised** — there's still no title-edit UI, so `createLesson`
  is plain insert-if-absent (`onConflict:"id", ignoreDuplicates`), which also prevents a client id
  from clobbering another owner's row. Wire real LWW (compare `updated_at`) when title editing ships.
- **No migration** (as planned): `gen_random_uuid()` stays the default; the app always supplies ids.
- **`navigator.onLine` ≠ server-reachable.** A dead server with a live network still reports
  `onLine: true`, so the flush *attempts* the action, fails, and keeps the outbox — same safe
  outcome as a true offline skip. Both paths converge on retry.
- **`navigator.storage.persist()`** is requested on mount (`ServiceWorkerRegister`, all envs).
  Chrome desktop may deny it by engagement heuristic (returns `false`, not an error); the installed
  iOS PWA — the actual target — grants it.
- **Key files:** `public/sw.js`, `src/app/OfflineApp.tsx`, `SyncProvider.tsx`, `NewLessonForm.tsx`,
  `ServiceWorkerRegister.tsx`, `offline/page.tsx`, `LessonsList.tsx`, `lessons/[id]/LessonItemsView.tsx`;
  `src/lib/sync/{db,mirror,engine,types}.ts`; `flushOutbox` in `src/app/lessons/actions.ts`
  (the former FormData mutation actions + `addLessonItems` were removed). Deps: `dexie`,
  `dexie-react-hooks`.
- **Still deferred / online-only (unchanged):** voice tutor, session history, and item-change
  history are not in the mirror — the offline lesson view shows words only. Cross-device
  convergence and the `/offline`→real-page **auto-reload on `online`** are coded but not
  multi-device tested.
```