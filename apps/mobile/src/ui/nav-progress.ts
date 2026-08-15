import { useEffect, useSyncExternalStore } from "react";

/**
 * Shared "something is in flight" store behind the top progress bar — the web's
 * `apps/web/src/app/nav-progress.ts`, minus its Next-specific half.
 *
 * Every transition of the bar is tied to a real event. Nothing here is timed or estimated; the one
 * timer in the feature (`NavProgressBar`'s reveal delay) exists to *suppress* the bar on fast work,
 * never to simulate progress. See docs/2026-07-26-navigation-progress-bar.md.
 *
 * A counter rather than a boolean: a tap can overlap the tail of the previous load, and a screen's
 * own fetch can be in flight alongside a route change. The bar stays up until the last one settles.
 *
 * **What drives it differs from the web, and that is the interesting part.** On the web a
 * navigation *is* the work: `<NavLink>` reports its `useLinkStatus`, and the server render is what
 * the bar is waiting for. Here a route change is instant — the screen mounts immediately and then
 * fetches. So the thing worth reporting is the fetch, not the push, and screens call
 * `useLoadingIndicator(loading)` while their own data is outstanding. Same bar, same store, honest
 * about a different event.
 */

let active = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Report that work has started. Returns its matching "finished" callback, which is safe to call
 * more than once — an unbalanced count would strand the bar on screen forever, and effect cleanups
 * can run twice under StrictMode.
 */
export function beginNavigation(): () => void {
  active += 1;
  emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active -= 1;
    emit();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while at least one piece of work is pending. */
export function useNavigationPending(): boolean {
  return useSyncExternalStore(subscribe, () => active) > 0;
}

/**
 * Hold the bar up for as long as `pending` is true.
 *
 * The screens' half of the contract: pass whatever local state means "I am waiting on the server".
 * The cleanup balances the count, so an unmount mid-fetch releases the bar rather than pinning it.
 */
export function useLoadingIndicator(pending: boolean): void {
  useEffect(() => {
    if (!pending) return;
    return beginNavigation();
  }, [pending]);
}
