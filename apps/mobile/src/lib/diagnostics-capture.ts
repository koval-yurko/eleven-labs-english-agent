import { AppState, type AppStateStatus } from "react-native";

import { buildDebugReport, emit } from "@/lib/diagnostics";
import { spoolReportSync } from "@/lib/diagnostics-spool";

/**
 * The three sources that write to the bus without anyone calling them: the console, the app state,
 * and a fatal error.
 *
 * ## Why console capture is worth twenty lines
 *
 * There is no `console.*` anywhere in `apps/mobile/src` — zero matches — and no capture. Everything
 * that reaches the console comes from an SDK, and some of it is load-bearing. From
 * `lib/tutor-session.tsx`, about the proactive kickoff:
 *
 * > Keyed on `status` and it must stay that way: `WebRTCConnection.sendMessage` drops anything sent
 * > before `RoomEvent.Connected` **with a console warning and no error**.
 *
 * On a TestFlight build that warning goes to an Xcode console nobody is attached to. If the keying
 * ever regresses the symptom is "the tutor doesn't say hello sometimes", and the only evidence has
 * already been discarded. The same is true of Daily's shim complaints, LiveKit's ICE warnings, and
 * every SDK deprecation notice. This is the highest ratio of evidence-per-line in the feature.
 *
 * **`console.log` is deliberately NOT captured.** Different signal-to-noise entirely, and the ring
 * is 300 entries — one chatty render loop would evict the failure it was logged next to.
 *
 * ## Why a crash is spooled and not sent
 *
 * The failure with the worst evidence-to-frequency ratio is a fatal JS error: the app disappears and
 * the ring goes with it. There is no time to send — `apiFetch` awaits a token round trip and then a
 * `fetch` with no timeout, and the process will not be there when either resolves. So the handler
 * writes the whole report to the spool **synchronously** and hands straight back to the previous
 * handler; the next launch picks it up.
 *
 * That pickup is **silent, with no card and no consent question** (D11), and it deliberately does
 * not follow the journal precedent — which *offers* a recovery rather than acting on it. The
 * difference is what is being handed over: a recovered journal is the learner's own speech, replayed
 * into a live conversation, so it is theirs to accept; a crash report is machine state about a
 * machine failure, filed to a row the same account already owns, carrying no transcript and no free
 * text. Nothing in it needs a decision from the person it happened to, and the reports most worth
 * having are exactly the ones nobody would stop to confirm. **Revisit if the learner and the
 * developer ever stop being the same person** — that is the premise this rests on, and the only one.
 */

/** Idempotent: the entry point calls this at module scope, and Fast Refresh re-runs module scope. */
let installed = false;

/**
 * React Native's global error hook. Not in `@types/react-native` as a global, and not worth a
 * module augmentation for two uses — it is a documented RN global with a stable two-method shape.
 */
type ErrorUtilsShape = {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
};

function errorUtils(): ErrorUtilsShape | null {
  const global = globalThis as { ErrorUtils?: ErrorUtilsShape };
  const utils = global.ErrorUtils;
  return utils && typeof utils.getGlobalHandler === "function" ? utils : null;
}

/** The joined arguments, bounded. A chatty SDK must not be able to evict the ring on its own. */
function describe(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        // Circular, or a native object. Its type is still worth more than a thrown stringify.
        return Object.prototype.toString.call(a);
      }
    })
    .join(" ")
    .slice(0, 200);
}

export function installDiagnosticsCapture(): void {
  if (installed) return;
  installed = true;

  emit({ level: "info", code: "app.launch", message: "app started" });

  // ── the console ────────────────────────────────────────────────────────────────────────────
  // WRAPPED, never replaced: RN's LogBox and the Metro console are still the primary way these are
  // read during development, and a capture that silenced them would trade a good debugging surface
  // for a worse one.
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      emit({
        level: level === "warn" ? "warn" : "error",
        code: level === "warn" ? "console.warn" : "console.error",
        message: describe(args),
      });
      original(...args);
    };
  }

  // ── the app state ──────────────────────────────────────────────────────────────────────────
  // Cheap, and the single most common question about a locked-screen bug is what the timeline of
  // foreground/background transitions looked like around the failure.
  AppState.addEventListener("change", (next: AppStateStatus) => {
    if (next === "active") emit({ level: "info", code: "app.foreground", message: "foreground" });
    else if (next === "background") emit({ level: "info", code: "app.background", message: "background" });
  });

  // ── the fatal error ────────────────────────────────────────────────────────────────────────
  const utils = errorUtils();
  if (!utils) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    const e = error as { message?: unknown; stack?: unknown } | null;
    emit({
      level: "error",
      code: "app.crash",
      message: String(e?.message ?? error),
      data: { fatal: Boolean(isFatal), stack: String(e?.stack ?? "").slice(0, 200) },
    });
    /**
     * Only a FATAL error parks a report. A non-fatal one leaves the app running, which means the
     * ring is still there and the modal can still be opened — and spooling every caught throw would
     * fill a ten-slot queue with reports nobody asked for.
     *
     * Wrapped, because the one thing this handler must not do is throw on its way to `previous` —
     * that would replace a reported crash with an unreported one.
     */
    if (isFatal) {
      try {
        spoolReportSync(buildDebugReport({ kind: "error", note: "" }));
      } catch {
        // The process is going down and the report is lost. `previous` still runs.
      }
    }
    // NEVER swallowed. LogBox, the red screen and any future crash reporter all still need it, and
    // a diagnostics layer that changed what happens to a crash would be observing its own shadow.
    previous(error, isFatal);
  });
}
