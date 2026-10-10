import { useEffect, useSyncExternalStore, useTransition } from "react";

/**
 * Shared "a navigation is in flight" store behind the top progress bar.
 *
 * Every transition of the bar is tied to a real event — the click that starts a navigation and
 * the commit that ends it. Nothing here is timed or estimated. The one timer in the UI
 * (`NavProgressBar`'s reveal delay) exists to *suppress* the bar on fast navigations, never to
 * simulate progress. See docs/2026-07-26-navigation-progress-bar.md.
 *
 * A counter rather than a boolean: a click can overlap the tail of the previous navigation, and
 * both a `<Link>` and a `startTransition` can be in flight at once. The bar stays up until the
 * last one settles.
 */

let active = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Report that a navigation has started. Returns its matching "finished" callback, which is safe
 * to call more than once — effect cleanups can run twice under StrictMode, and an unbalanced
 * count would strand the bar on screen forever.
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

/** The server never has a navigation in flight, so the first client render matches it exactly. */
const getServerSnapshot = () => 0;

/** True while at least one navigation is pending. */
export function useNavigationPending(): boolean {
  return useSyncExternalStore(subscribe, () => active, getServerSnapshot) > 0;
}

/**
 * `startTransition` for programmatic `router.push` / `router.replace`, wired to the same store
 * that `<NavLink>` feeds. `useLinkStatus` only covers anchors, so without this the bar would
 * miss every navigation the app makes on the user's behalf.
 */
export function useNavigationTransition(): (action: () => void) => void {
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!isPending) return;
    return beginNavigation();
  }, [isPending]);

  return startTransition;
}
