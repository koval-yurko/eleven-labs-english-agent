# Refresh button on the words page (list + detail)

**Date:** 2026-08-09
**Scope:** `/lesson-items` (list) and `/lesson-items/[id]` (detail)
**Status:** implemented. Three things changed between the design below and the code — each is noted
inline as **Built:**.

## The problem

A word is enriched **after** it is added, by two background jobs:

- `levelItems` fills `words.level` (`apps/web/src/lib/levels.ts`)
- `enrichWords` fills `words.details` (`apps/web/src/lib/word-details.ts`)

Both are kicked from `addWordAction` inside `after()` (`apps/web/src/app/lesson-items/actions.ts:52-68`)
and both are backstopped by a sweep (`pnpm level:items`, `pnpm enrich:words`). The `revalidatePath`
on line 48 fires **before** either job has produced anything — it can only ever invalidate the
pre-enrichment state.

Both pages are `export const dynamic = "force-dynamic"` server components, rendered once per
request. Nothing pushes. So the learner adds "ubiquitous", sees it appear with no level and
_"Details are being prepared…"_, and has no way to see the finished payload short of navigating away
and back, or hard-reloading the tab.

The ask — a small icon button on the list's `XX items` row and on the detail page's `← back` row —
is the right size for this. What follows is what it should do, and the three places the codebase
already has an opinion.

## Mechanism: `router.refresh()`, not `location.reload()`

`router.refresh()` re-runs the server component for the **current** URL and streams new props into
the mounted client tree. React state is preserved because the client components are re-rendered, not
remounted.

That distinction is load-bearing on the list page, which holds three pieces of state a reload would
destroy:

| State | Where | Lost on `location.reload()`? |
| --- | --- | --- |
| `search` (the `?q=` box) | `ItemsBrowser.tsx:70` | Survives — it's mirrored into the URL by `onSearch` |
| `selected` (id → text map) | `ItemsBrowser.tsx:77` | **Yes** — and it's explicitly designed to accumulate across filter changes |
| `lessonTitle`, scroll position | `ItemsBrowser.tsx:78` | **Yes** |

The `selected` map is the one that matters. Its comment (`ItemsBrowser.tsx:72-76`) spells out that
it is deliberately _not_ pruned when the view changes, so a learner can tick words across several
filtered views and create one lesson from the union. A reload silently throws that away. A refresh
does not.

Caching is a non-issue in all four layers:

- **Full Route Cache** — both pages are `force-dynamic`, so there is nothing to invalidate.
- **Client Router Cache** — `router.refresh()` busts it for the current route.
- **Service worker** — `public/sw.js:64-99` only intercepts `mode === "navigate"` and
  `/_next/static/*`. An RSC refresh fetch is neither, so it goes straight to the network.
- **`revalidatePath`** — not needed. That's the tool for a server _mutation_ telling other clients;
  here the client is asking, and the ask itself is the round trip.

### Progress feedback is already built

`useNavigationTransition()` (`apps/web/src/app/nav-progress.ts:60-69`) wraps `startTransition` and
reports pending state to the shared store behind the top progress bar. `router.refresh()` inside a
transition keeps `isPending` true until the new payload commits. So:

```ts
const startNavigation = useNavigationTransition();
startNavigation(() => router.refresh());
```

gets the top bar for free, with the same suppress-if-fast behaviour every other navigation has
(`docs/2026-07-26-navigation-progress-bar.md`). `ItemsBrowser` already imports this hook and uses it
for exactly this purpose on line 133.

### Offline: the button must be disabled, not merely fail

`NavLink.tsx:42-53` documents the trap: offline, an RSC fetch is **not** intercepted by the service
worker, so it fails and surfaces a router error rather than the offline shell. NavLink works around
it by falling back to a full document navigation. A refresh has no such fallback — there is no
document to fall back to that would be any fresher.

So the button should be disabled while `navigator.onLine === false`, using the listener pattern
already in `AddWordForm.tsx:25-36` (read in an effect, never during render — a rendered offline
state is a hydration mismatch). This would be the **second** copy of that ~10-line effect; a small
`useOnline()` hook in `apps/web/src/app/` is worth extracting at the same time, and `NewLessonForm`
/ `ItemsBrowser` / `SyncProvider` read `navigator.onLine` imperatively too.

> **Built** (`useOnline.ts`): `useSyncExternalStore` rather than the effect-into-state copy.
> `getServerSnapshot = () => true` is the purpose-built answer to the hydration problem the old
> comment described, and it drops the mirrored `useState` entirely. `AddWordForm` now calls it;
> the three imperative `navigator.onLine` reads elsewhere are one-shot checks inside handlers, not
> rendered state, so they were left alone.

## Component shape

One shared client island, since both pages want the identical thing:

```
apps/web/src/app/RefreshButton.tsx   (new, "use client")
apps/web/src/app/icons/index.tsx     (add RefreshIcon — lucide refresh-cw)
```

```tsx
"use client";
export function RefreshButton({ label = "Refresh" }: { label?: string }) {
  const router = useRouter();
  const startNavigation = useNavigationTransition();
  const [pending, startLocal] = useTransition();   // for the local spin/disable
  const offline = useOnline() === false;

  return (
    <Tooltip label={offline ? "Offline — can’t refresh" : label}>
      <Button variant="icon" aria-label={label} disabled={pending || offline}
              onClick={() => startNavigation(() => startLocal(() => router.refresh()))}>
        <RefreshIcon size={18} className={pending ? "spin" : undefined} />
      </Button>
    </Tooltip>
  );
}
```

`Button variant="icon"` is the existing square, chrome-free tier (`globals.css:530-535`, and note
its comment that it is deliberately not `--control-height`). `Tooltip` is the hover-only hint —
correct here because the label is redundant with `aria-label`, per its own doc comment
(`Tooltip.tsx:6-19`). `FavoriteButton.tsx` is the exact precedent for icon + tooltip + transition.

> **Built** (`RefreshButton.tsx`): **one** transition, not two. The sketch above nested
> `startNavigation` around a local `useTransition` — `startNavigation` to drive the top bar, the
> local one to drive the spin — but nested `startTransition` calls make which hook observes the
> update a subtlety not worth relying on. The button instead keeps only its own `useTransition` and
> reports to the shared store directly with `beginNavigation()` in an effect. That is not a
> workaround: it is precisely what `useNavigationTransition` does internally
> (`nav-progress.ts:63-66`) and what `NavLink`'s `PendingReporter` already does
> (`NavLink.tsx:12-23`). One pending source, both indicators.
>
> **Built** (offline): the reason lives in the visible status line, not the tooltip. A disabled
> `<button>` fires no pointer events, so a tooltip on one never opens — and `Tooltip`'s own doc
> comment (`Tooltip.tsx:6-19`) says content a touch user would lose isn't a tooltip in the first
> place. The line reads `offline` instead of `checked 14:32` while the connection is down; the
> tooltip keeps only the redundant label.

### Placement

**List** — `ItemsBrowser.tsx:260-263`. The heading becomes a row:

```tsx
<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
  <h2 style={{ margin: 0, flex: 1 }}>{visible.length} {visible.length === 1 ? "item" : "items"}</h2>
  <RefreshButton label="Refresh list" />
</div>
```

`ItemsBrowser` is already `"use client"`, so this is a plain import.

**Detail** — `[id]/page.tsx:37-39`, the `← words & sentences` row:

```tsx
<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
  <p className="muted" style={{ margin: 0, flex: 1 }}>
    <NavLink href="/lesson-items">← words &amp; sentences</NavLink>
  </p>
  <RefreshButton label="Refresh word" />
</div>
```

The page stays a server component — only the button is an island. This is the same arrangement
`FavoriteButton` already has on that page (line 42).

### Spin, and reduced motion

`globals.css` has no generic spin keyframe yet (the only animations are the nav bar's, lines
607-643). Adding one means adding the `prefers-reduced-motion` guard beside it, matching the
existing block at 635-643:

```css
@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 800ms linear infinite; }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
```

With motion reduced the button still communicates via `disabled` and the progress bar.

## The honest gap: a refresh that changes nothing looks broken

Enrichment takes seconds to tens of seconds. A learner who clicks 200ms after adding a word gets an
identical page, a 200ms spinner, and no signal that the button worked. This is the one real UX
decision in the feature, and there are three answers:

1. **Nothing extra.** The progress bar flashes; the data is what it is. Cheapest, and defensible —
   but it is exactly the "dead button" complaint.
2. **A `role="status"` line that reports the outcome.** e.g. `Updated · 14:32` after every refresh.
   Cheap, announced to screen readers, and doesn't lie: it says when we last asked, not that
   anything changed. The `Field.Description role="status"` pattern in `AddWordForm.tsx:88-105` is
   the precedent.
3. **Report whether anything actually changed.** Requires diffing the new server payload against
   the old, which means holding the previous `items` / `details` in client state and comparing —
   real complexity for a small payoff.

**Recommendation: (2).** One muted line, near the button, cleared on the next interaction.

> **Built:** a `role="status"` span left of the button reading `checked 14:32`, stamped when the
> transition settles and cleared the moment the next refresh starts. The wording is deliberate — it
> reports when we *asked*, which is true, rather than claiming something *changed*, which option (3)
> would be needed to know.

## Should refresh also _re-trigger_ the job?

Tempting, and mostly wrong. The distinction to hold onto is the one CLAUDE.md already makes about
`details_at` / `level_at` being the **attempted** flag, not the succeeded flag:

- `details == null && details_at == null` → queued or in flight. Refresh is the right tool; the data
  is coming.
- `details == null && details_at != null` → the model had no usable answer. **Terminal by design**
  (a non-English token, a made-up word). Re-triggering here re-asks a question already answered, on
  every click, at LLM cost. The detail page already renders this state honestly as _"No extra
  details for this one."_ (`[id]/page.tsx:104-120`).

The genuine failure mode a pure refresh cannot fix: the `after()` call threw and was swallowed
(`actions.ts:56`, `actions.ts:66`) and the sweep hasn't run. Then `details_at` is still null and the
page says _"Details are being prepared…"_ forever. But note that this is precisely the case the
sweep exists to cover — `pnpm enrich:words` will pick it up, and the job's whole design (`level` and
`details` nullable forever, no deadline, no scheduler) is built around that.

**Recommendation: v1 refreshes only.** If a re-trigger is ever added, gate it hard: detail page
only, only when `details_at === null`, `after()`-dispatched from a server action, and rate-limited —
a user-clickable button that fires an LLM call is a cost surface that doesn't exist anywhere else in
this app today.

## Alternative considered: poll instead of a button

An automatic re-check while `details == null` would remove the click entirely. Rejected for v1:

- It adds a timer to a codebase that deliberately has almost none — `nav-progress.ts:3-9` states the
  rule outright ("Nothing here is timed or estimated"), and the one timer that exists is there to
  _suppress_ UI, not to simulate progress.
- The wait is unbounded on the sweep path (minutes to hours), so any poll interval is either too
  eager or useless.
- It cannot distinguish "in flight" from "attempted, nothing to say" without the same `details_at`
  reasoning above — so it would poll forever on terminal words.

A defensible **v2**, scoped narrowly: on the detail page only, when `details_at === null`, fire
_one_ `router.refresh()` after ~15s. One shot, one condition, no interval. Not part of this change.

## Files touched

| File | Change |
| --- | --- |
| `apps/web/src/app/RefreshButton.tsx` | new — the shared island |
| `apps/web/src/app/useOnline.ts` | new — replaces `AddWordForm`'s effect |
| `apps/web/src/app/icons/index.tsx` | add `RefreshIcon` |
| `apps/web/src/app/globals.css` | `@keyframes spin` + reduced-motion guard |
| `apps/web/src/app/lesson-items/ItemsBrowser.tsx` | heading → flex row + button |
| `apps/web/src/app/lesson-items/[id]/page.tsx` | back-link → flex row + button |
| `apps/web/src/app/lesson-items/AddWordForm.tsx` | use the extracted `useOnline` |

Nothing in `packages/shared` — this is presentation and Next plumbing, which is precisely what
CLAUDE.md's test excludes ("could I fix a bug in it by deploying the web app alone?" — yes).

No migration, no server action, no new route.

## Verification

- `pnpm typecheck` — passes. `pnpm build` — passes. `pnpm --filter web lint` and
  `pnpm --filter @tutor/shared lint` — both clean. (`pnpm lint` from the root fails with
  `Command "eslint" not found`; that reproduces on a clean tree with this change stashed, so it is a
  pre-existing workspace-script problem and not part of this change. Worth a separate look.)
  `pnpm check:shared` is unaffected — nothing in `packages/shared` changed.
- Manual: add a word → the list shows it unlevelled → wait → refresh → level badge appears without
  the search box clearing or the selection resetting.
- Manual: tick three words across two different level filters, refresh, confirm the sticky
  "3 selected" bar is intact. This is the regression a `location.reload()` implementation would fail.
- Manual: DevTools → offline → button is disabled and no router error appears in the console.
- Manual: reduced motion on → button still disables while pending.
