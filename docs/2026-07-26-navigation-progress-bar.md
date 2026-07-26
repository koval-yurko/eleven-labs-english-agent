# Top-of-page navigation progress bar

**Status:** research. Nothing implemented.
**Date:** 2026-07-26

---

## TL;DR

The reason clicking **Words** / **Lessons** shows nothing for half a second is not a missing
spinner — it is that those links are plain `<a href>`, so the browser does a **cross-document
navigation** and *freezes the outgoing page*. Measured below: over 1382 ms after the click, the old
page rendered **1 animation frame**. No progress bar can be drawn in a frozen document, so this
cannot be fixed by adding UI. The navigation has to become client-side (`next/link`) first — after
that a real-signal bar is straightforward.

On "not fake timers": worth being straight about what is achievable. Today ~98 % of the wait is a
single opaque server think-time — one request, 9–18 kb, ~4 ms of download. There are no sub-resources
to count, so a byte-accurate 0→100 % bar is **not** obtainable from the current architecture. What
*is* obtainable, and what this document proposes:

- a **real start** (the click) and a **real end** (React commits the new route) — these alone are
  the entire difference from a fake timer, which guesses both;
- **real intermediate checkpoints**, but only if we create them, by splitting the page's server
  work into `Suspense` boundaries so it streams. Each boundary resolving is a genuine event the bar
  can step on. This is the honest reading of "track which resources need to load and wait for them":
  in this app the "resources" are **server-side DB queries**, and streaming is what makes them
  observable to the browser.

Recommendation: **Phase 1 + 2 below** (`next/link` + a real-signal bar). Phase 3 (streaming) turns
the bar from two-state into genuinely stepped, and Phase 4 mostly removes the wait altogether.

---

## Part 1 — Why there is no feedback today

### 1a. The links are cross-document navigations

`src/app/layout.tsx:63-72` uses plain anchors:

```tsx
<a href="/lesson-items">Words</a>
<a href="/lessons">Lessons</a>
```

Next.js does not intercept plain `<a>`. Every header click tears down the whole document — React,
the Dexie mirror connection, and any bar you might have rendered.

### 1b. Where the time goes (measured on prod, from Kyiv → `arn1`)

TTFB, three samples each, cache disabled:

| Route | Kind | TTFB (warm) | Notes |
|---|---|---|---|
| `/offline` | static | **121 ms** | network + edge baseline |
| `/lessons` | `force-dynamic` | **358–665 ms** | Auth0 session + `listLessons` |
| `/lesson-items` | `force-dynamic` | **355–560 ms** | Auth0 session + `listItems` ∥ `listItemFacets` |
| `/lessons` | cold start | **2761 ms** | observed once on a real navigation |

Breakdown of a real navigation (`performance.getEntriesByType('navigation')`):

```
requestStart → responseStart (server):  2761 ms   ← 98.5 %
responseStart → responseEnd (download):    4 ms
responseEnd → domContentLoaded:            9 ms
transferSize: 25 kb
```

So the wait is **one blocking server render**, not asset loading. Subtracting the 121 ms baseline,
actual server work is roughly **230–540 ms warm**, up to ~2.6 s cold. Both pages are
`export const dynamic = "force-dynamic"` with no `Suspense`, so the response is withheld until every
query has finished.

### 1c. The decisive experiment: the outgoing page is frozen

I started a `requestAnimationFrame` loop *and* a 16 ms `setInterval` on `/lesson-items`, let them run
300 ms, then triggered `location.href = '/lessons'`, persisting counters to `sessionStorage` so they
survived the swap. Result:

```
old page ran 1 rAF frame / 2 timer ticks over 1682 ms total
  (300 ms of that was before the navigation started)
  => ~1382 ms of post-click life, essentially unpainted
new doc TTFB: 1181 ms
```

Chrome suspends rendering of a document the moment a cross-document navigation commits. **An
animated bar in the outgoing page is impossible** — it would freeze on its first frame. And a bar in
the *incoming* page is useless: it cannot paint until `responseStart`, by which point 98 % of the
wait is already over.

This also rules out **cross-document View Transitions** (`@view-transition { navigation: auto }`) as a
solution. It can cross-fade the swap, but the frozen window is still frozen — it hides the seam, it
does not show progress.

**Conclusion: the bar is blocked on making navigation client-side. That is the actual work item.**

---

## Part 2 — The real signals available

Once navigation is client-side, the current page stays alive and interactive while the RSC payload
is fetched. Measured cost of that fetch (what the bar would actually be covering):

| Route | RSC payload | Time |
|---|---|---|
| `/lessons` | 9 kb | 224–406 ms |
| `/lesson-items` | 18 kb | 226–340 ms |

Signals, in order of fidelity:

| Signal | Source | Real? | Covers |
|---|---|---|---|
| Link click pending | `useLinkStatus()` (Next ≥15.3; **16.2.9 installed, verified**) | ✅ | header nav, lesson links |
| Programmatic nav pending | `useTransition()` around `router.push/replace` | ✅ | `NewLessonForm.tsx:52`, `ItemsBrowser.tsx:108,134` |
| Route committed | the new route's `useEffect` / `usePathname` change | ✅ | the end of the bar |
| Suspense boundary resolved | streaming, **once we add boundaries** | ✅ | genuine mid-progress steps |
| Bytes received | `fetch` + `ReadableStream` on the RSC response | ⚠️ | Next owns this fetch; not exposed |
| Elapsed-time trickle | a timer | ❌ | what we are avoiding |

`useLinkStatus` has one shape constraint worth knowing up front: **it only works inside a `<Link>`**.
A global top bar therefore needs a tiny sentinel component rendered inside each `Link` that publishes
into a shared store (`useSyncExternalStore` or context), which the bar in the layout subscribes to.

---

## Part 3 — Proposed architecture

### Phase 1 — make navigation client-side (prerequisite)

Replace the header anchors and in-page navigation anchors with `next/link`. Affected: `layout.tsx`
(3 anchors), `lesson-items/[id]/page.tsx:36`, `lessons/[id]/page.tsx:133`, `demo/page.tsx:56`,
`OfflineApp.tsx:53,92`, and the item links in `ItemsBrowser.tsx:371`.

On its own this already changes the felt experience: the old page stays interactive instead of
freezing, and the wait drops from 355–665 ms to 224–406 ms (no document teardown, no re-download of
CSS/JS, no re-hydration).

### Phase 2 — the bar, driven by real start/end

```
NavProgressProvider (client, in layout)
  ├── store: { active: boolean, startedAt, checkpoints }
  ├── <NavProgressBar/>            — fixed top, 3px, var(--accent)
  └── <LinkPending/>               — sentinel inside each <Link>, calls useLinkStatus()
                                     and reports pending → store
```

- **Start**: any sentinel reports `pending: true`, or a `useTransition` wrapping a programmatic
  `router.push` reports `isPending`.
- **End**: `usePathname()` changes *and* the transition settles → animate to 100 %, fade out.
- **In between (Phase 2 only)**: with no streaming yet there is genuinely nothing to report. Use an
  **indeterminate** treatment — a sliding shimmer — rather than a percentage. It is honest: it says
  "working", not "you are 60 % done". Do not use a trickle here; a trickle *is* the fake timer.

### Phase 3 — create real checkpoints by streaming

This is what makes the bar genuinely stepped, and the direct answer to "track which resources need
to load".

Add `loading.tsx` to `/lessons` and `/lesson-items`, and wrap each independent server fetch in its
own `Suspense`. On `/lesson-items` the page already does `Promise.all([listItems, listItemFacets])`
— split those into two boundaries and you get two real milestones instead of one blocking await:

```tsx
export default function LessonItemsPage({ searchParams }) {
  return (
    <>
      <h1>Words &amp; sentences</h1>            {/* static shell — instant */}
      <Suspense fallback={<FacetsSkeleton />}>
        <Facets />                              {/* checkpoint 1 */}
      </Suspense>
      <Suspense fallback={<ItemsSkeleton />}>
        <Items searchParams={searchParams} />   {/* checkpoint 2 */}
      </Suspense>
    </>
  )
}
```

The bar then advances on: shell committed → boundary 1 resolved → boundary 2 resolved → done. Every
step corresponds to a server query actually finishing. Each boundary's fallback reports its own
mount/unmount into the same store.

Adding `loading.tsx` has a second, larger payoff: **dynamic routes are not prefetched by default
unless a `loading.js` is present**. With it, the static shell is prefetched on hover/viewport, so the
click paints instantly and only the data streams in.

### Phase 4 — mostly remove the wait

Next 16 supports runtime prefetching for dynamic routes:

```ts
export const prefetch = 'allow-runtime'
```

with the dynamic parts behind `Suspense`. The payload is fetched on hover/viewport, so a deliberate
click is often already resolved and the bar never appears. Note the trade-off: prefetch fires real
Auth0 + Supabase work per hover, so it raises server load — worth measuring before enabling globally.

Also available and cheaper: **`/lessons` already has a local-first path.** `LessonsList` renders from
the Dexie mirror via `useLiveQuery` with `initial` only as a seed. A client-side navigation could
paint the mirror's contents immediately and let the server response reconcile — near-zero perceived
wait, no extra server load. `/lesson-items` has no equivalent mirror today.

---

## Part 4 — Bar design notes

- Fixed, `top: 0`, full width, 2–3 px, `background: var(--accent)`, above everything
  (`z-index` over the header), `pointer-events: none`.
- Respect the safe-area inset — the app runs standalone on iOS with `viewport-fit=cover`.
- **Do not show it for fast navigations.** Delay appearance by ~120 ms; a prefetched route that
  resolves in 40 ms should flash nothing. This is the single biggest quality difference between a
  good bar and an annoying one.
- On completion, animate to 100 % then fade — never snap away.
- `role="progressbar"` + `aria-busy` on completion-unknown states; honour
  `prefers-reduced-motion` (fade only, no slide).
- **Render nothing on the server.** Its initial state must be identical server and client, or it
  reintroduces exactly the hydration-mismatch class of bug fixed in
  `docs/2026-07-26-light-theme-reverts-to-dark-on-navigation.md`.

---

## Part 5 — Risks and interactions specific to this codebase

1. **The service worker only intercepts `request.mode === "navigate"`** (`public/sw.js:93`). Today an
   offline click serves the `/offline` shell. After Phase 1 those become RSC `fetch`es, which the SW
   ignores → offline navigation would fail with a Next error instead of the offline shell. **This
   must be handled as part of Phase 1**, either by teaching the SW about RSC requests or by having
   the router fall back to a hard navigation when offline.

2. **`ItemsBrowser.tsx:134` calls `router.replace` on every filter/sort toggle.** Wired naively, the
   bar would fire on every chip click. Decide deliberately: either exclude `replace`-with-`scroll:
   false`, or show the bar (arguably correct — it *is* a real server round-trip).

3. **Prefetch multiplies authenticated server work.** Every hover on a `Link` to a `force-dynamic`
   route with `loading.tsx` costs an Auth0 session decrypt plus Supabase queries. Measure before
   enabling broadly.

4. **Cold starts (2.7 s) dominate the tail.** No client-side work fixes those; they are worth
   attacking separately, and they are the strongest argument for the Phase 3 streaming shell — with
   a prefetched shell the user at least sees layout immediately.

---

## Part 6 — Options considered

| Option | Real signals | Verdict |
|---|---|---|
| Bar in the current `<a>` architecture | none — document frozen | ❌ impossible (Part 1c) |
| Cross-document View Transitions | none during the wait | ❌ hides the seam, shows no progress |
| `nprogress` / `bprogress` off-the-shelf | start/end real, middle is a **timer trickle** | ⚠️ exactly the fake-timer behaviour to avoid; usable only if the trickle is disabled |
| `useLinkStatus` inline hint only (Next's own example) | start/end real | ✅ smallest honest option; no top bar |
| **Custom bar on real store + streaming checkpoints** | start, end, and per-boundary all real | ✅ **recommended** |

---

## Part 7 — How to verify it is real, not decorative

1. Throttle to Slow 3G and confirm the bar's *start* is within one frame of the click (not delayed
   by a timer) and its *end* coincides with the new content painting.
2. Add an artificial 3 s delay to one Suspense boundary; the bar must stall at that checkpoint's
   percentage — a fake bar would sail past it.
3. Prefetched/instant navigation must show **no** bar at all (the 120 ms delay threshold).
4. Re-run the `performance.getEntriesByType('navigation')` probe from Part 1b after Phase 1 — there
   should no longer *be* a new navigation entry per header click.
5. Offline: confirm risk #1 above is handled before shipping Phase 1.
