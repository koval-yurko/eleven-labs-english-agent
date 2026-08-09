import { useSyncExternalStore } from "react";

/**
 * Whether the browser currently believes it has a connection.
 *
 * `navigator.onLine` is a browser-only fact, so reading it during render is a hydration mismatch —
 * which is why every call site so far read it inside an effect and mirrored it into state (see the
 * note this replaces in `AddWordForm`). `useSyncExternalStore` is the shape that exists for exactly
 * this: `getServerSnapshot` makes the first client render match the server (`true` — the server has
 * no opinion, and a control that renders enabled and then disables is better than one that flashes
 * the other way), and React re-reads the real value right after hydration.
 *
 * It reports the browser's *belief*: `true` means "there is a network interface", not "the server is
 * reachable". Good enough for disabling a control that would otherwise fail loudly; never a
 * substitute for handling a failed request.
 */

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const getSnapshot = () => navigator.onLine;
const getServerSnapshot = () => true;

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
