import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useAccessToken, useSession } from "@/lib/auth";
import { emit } from "@/lib/diagnostics";
import { flushSpool } from "@/lib/diagnostics-spool";

/**
 * Send whatever the spool is holding, at launch and on every return to the foreground.
 *
 * ## Why this is a hook and the rest of the capture is not
 *
 * `diagnostics-capture.ts` installs at module scope, before the first render, because a console
 * warning or a crash can happen before React exists. A SEND cannot: it needs an access token, and
 * the token source is `useAccessToken()` — a hook value, and one that is deliberately called per
 * request rather than cached in a module (see `api.ts`). So the delivery half lives in React and the
 * capture half does not, which is also the boundary between "must never fail" and "may fail".
 *
 * ## Why foreground, and why also launch
 *
 * The two cover different failures. **Foreground** is the ordinary one: a report was filed with no
 * network, the learner walked to somewhere with signal, and the app came back. **Launch** is the
 * crash pickup — a fatal error parked a report synchronously on its way down (see
 * `diagnostics-capture.ts`), and the process that would have sent it no longer exists. The next
 * launch is the first moment anything can.
 *
 * That pickup is silent by design (D11): no card, no consent question. A crash report is machine
 * state about a machine failure, filed to a row this account already owns, carrying no transcript
 * and no free text.
 *
 * ## Why it waits for a session
 *
 * A flush while signed out would spend the whole queue on `ApiFetchError(0, "Not signed in.")` —
 * which is not a 4xx, so nothing would be discarded, but it would burn a wake-up doing nothing.
 * Gated on the session being live instead, which also means the first flush of a cold start happens
 * after the silent login rather than racing it.
 */
export function useDebugSpoolFlush(): void {
  const accessToken = useAccessToken();
  const signedIn = useSession().status === "signed-in";

  /**
   * "Runs whenever, reads the latest" — the same pattern as `latestControls` in the session, and
   * for the same reason: the subscription below must not be torn down and rebuilt every time the
   * token source changes identity, which it does on every render of the auth provider.
   */
  const latest = useRef(accessToken);
  useEffect(() => {
    latest.current = accessToken;
  });

  /**
   * Keyed on `signedIn`, and that is what makes the launch pass work.
   *
   * At a cold start the session is not live yet — the silent login is still in flight — so a drain
   * fired from `[]` would spend the whole queue on "Not signed in.". Re-running when the session
   * arrives means the crash pickup happens as soon as it CAN, which is the first moment a token
   * exists. It costs one extra subscribe/unsubscribe per app run.
   */
  useEffect(() => {
    if (!signedIn) return;
    /**
     * One flush at a time. `AppState` can fire `active` more than once around a system alert or a
     * control-centre pull, and two concurrent drains would send the same report twice — the exact
     * duplication the 4xx/5xx retry policy exists to avoid.
     */
    let draining = false;
    const drain = () => {
      if (draining) return;
      draining = true;
      void flushSpool(latest.current)
        .then((cleared) => {
          if (cleared > 0) {
            emit({
              level: "info",
              code: "spool.sent",
              message: `sent ${cleared} spooled report${cleared === 1 ? "" : "s"}`,
              data: { cleared },
            });
          }
        })
        .catch(() => {
          // `flushSpool` swallows its own failures; this is the belt for a rejection it could not.
        })
        .finally(() => {
          draining = false;
        });
    };

    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") drain();
    });
    // The launch pass — the crash pickup. `AppState` does not fire `active` for the state the app
    // starts in, so without this a report parked by a fatal error would wait for the first
    // background/foreground round trip.
    drain();
    return () => subscription.remove();
  }, [signedIn]);
}
