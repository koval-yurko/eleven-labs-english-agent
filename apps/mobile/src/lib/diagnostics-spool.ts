import Storage from "expo-sqlite/kv-store";

import { API_V2_ROUTES, isDebugReportResponse } from "@tutor/shared/api";
import { sanitizeDebugReport, type DebugReportInput } from "@tutor/shared/debug/report";

import { apiFetch, ApiFetchError, type TokenSource } from "@/api";
import { emit } from "@/lib/diagnostics";
import { isFinalRefusal } from "@/lib/retry-policy";

/**
 * Reports that could not be sent, parked on the device until they can be.
 *
 * ## Why this exists at all
 *
 * A report is generated at the exact moment things are broken, and "broken" is frequently *"the
 * request that would file this report will also fail"*. Sending inline and giving up on failure
 * would lose precisely the reports worth having — the ones filed from a phone with no network, or
 * against a backend that is down, which is the failure the learner was trying to describe.
 *
 * ## Why NOT the offline outbox
 *
 * `@tutor/shared/offline/ops` is a closed union validated server-side by `parseOutboxRecords`, and
 * its whole design goal is that a lesson mutation can be queued in SQLite and the flush handler
 * never learns the difference. A 60 KB diagnostic blob is not a lesson mutation: it needs no
 * ordering against other ops, no applied/retry semantics, and it would make every flush batch fat.
 * Forty lines here keep the op algebra clean. (If the outbox ever grows blob support for another
 * reason, revisit.)
 *
 * ## Everything swallows
 *
 * Same rule as `session-journal.ts`, for the same reason and one more: a spool that breaks the app
 * it is reporting on is worse than no spool, and a spool that throws inside a crash handler takes
 * the crash report down with it.
 *
 * See docs/2026-09-09-mobile-debug-reports-and-feedback.md §11.
 */

const KEY = "debug-report-spool";

/**
 * Ten, oldest dropped.
 *
 * Deliberately small. A spool that has grown past ten is a spool whose sends are systematically
 * failing, and in that state the OLDEST reports are the least useful — the failure has been going
 * on long enough that the recent ones describe it better. Bounded so a phone that is offline for a
 * week does not accumulate megabytes of blobs it will never send.
 */
export const MAX_SPOOLED_REPORTS = 10;

function parse(raw: string | null): DebugReportInput[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Re-sanitized on the way OUT as well as in. The blob on disk was written by a possibly older
    // build of this app, which is the same trust posture the server takes toward the phone.
    return parsed
      .map((entry) => sanitizeDebugReport(entry))
      .filter((r): r is DebugReportInput => r !== null);
  } catch {
    return [];
  }
}

async function read(): Promise<DebugReportInput[]> {
  try {
    return parse(await Storage.getItem(KEY));
  } catch {
    return [];
  }
}

async function write(reports: DebugReportInput[]): Promise<void> {
  try {
    await Storage.setItem(KEY, JSON.stringify(reports.slice(-MAX_SPOOLED_REPORTS)));
  } catch {
    // Nothing to do and nothing to say: the report is already lost, and the app is mid-failure.
  }
}

/**
 * Park a report.
 *
 * Sanitized BEFORE it is written rather than after it fails to upload — an over-large report should
 * be trimmed while trimming is still cheap, not once it is already occupying the device.
 */
export async function spoolReport(report: DebugReportInput): Promise<void> {
  const clean = sanitizeDebugReport(report);
  if (!clean) return;
  await write([...(await read()), clean]);
}

/**
 * The same, **synchronously**, for the global error handler and nothing else.
 *
 * A fatal JS error is the failure with the worst evidence-to-frequency ratio — the app disappears
 * and the ring goes with it — and there is no time to await anything: the handler must write and
 * hand straight back to the previous handler. `expo-sqlite/kv-store` exposes a synchronous API for
 * exactly this shape of problem, and a spool write is rare enough that blocking the JS thread once,
 * during a crash, costs nothing that is not already lost.
 *
 * Not used anywhere else: on the normal path the async version keeps the write off the hot path.
 */
export function spoolReportSync(report: DebugReportInput): void {
  try {
    const clean = sanitizeDebugReport(report);
    if (!clean) return;
    const existing = parse(Storage.getItemSync(KEY));
    Storage.setItemSync(KEY, JSON.stringify([...existing, clean].slice(-MAX_SPOOLED_REPORTS)));
  } catch {
    // The process is already going down. There is nowhere left to report a failure to report.
  }
}

export async function spooledCount(): Promise<number> {
  return (await read()).length;
}

/**
 * Did this report leave the device for good, or should it be tried again later?
 *
 * `isFinalRefusal` is the whole of the retry policy, and it is the mitigation for the one real risk
 * this feature has (§14): **a report the server REFUSES will never be accepted**, so retrying it is
 * a loop that cannot terminate in success and that fills the per-owner rate limit with its own
 * retries. Any answer from the server — 2xx or 4xx — ends the transaction; only a server fault or a
 * dead network earns another attempt.
 *
 * The predicate lives in `lib/retry-policy.ts` rather than here because the journal restore in
 * `tutor-session.tsx` has to answer identically, and it protects the same thing: data that exists
 * only on this device.
 */
type Delivery = { gone: true; id: string | null; stored: boolean } | { gone: false; reason: string };

async function deliver(report: DebugReportInput, getToken: TokenSource): Promise<Delivery> {
  try {
    const res = await apiFetch<unknown>(API_V2_ROUTES.debugReports, getToken, {
      method: "POST",
      body: JSON.stringify(report),
    });
    return isDebugReportResponse(res)
      ? { gone: true, id: res.id, stored: res.stored }
      : { gone: true, id: null, stored: true };
  } catch (e) {
    const status = e instanceof ApiFetchError ? e.status : 0;
    const reason = e instanceof Error ? e.message : String(e);
    return isFinalRefusal(status) ? { gone: true, id: null, stored: false } : { gone: false, reason };
  }
}

export type SendOutcome =
  | { kind: "sent"; id: string | null }
  /** The server took it and did not keep it — the per-owner hourly cap, or a refusal. */
  | { kind: "dropped" }
  | { kind: "spooled"; reason: string };

/** Try to send one report now; park it if the road is closed. What the `Send` button calls. */
export async function sendOrSpool(
  report: DebugReportInput,
  getToken: TokenSource,
): Promise<SendOutcome> {
  const result = await deliver(report, getToken);
  if (!result.gone) {
    await spoolReport(report);
    // Emitted into the ring, which means it travels in the NEXT report. That is the only way the
    // reporting channel's own failures are ever observable: a report that never arrives cannot
    // tell you it never arrived.
    emit({ level: "warn", code: "spool.queued", message: result.reason, data: { kind: report.kind } });
    return { kind: "spooled", reason: result.reason };
  }
  if (!result.stored) {
    emit({ level: "warn", code: "spool.dropped", message: "the server did not keep the report" });
    return { kind: "dropped" };
  }
  return { kind: "sent", id: result.id };
}

/**
 * Drain the spool, oldest first, **stopping on the first road-closed answer.**
 *
 * Stopping rather than continuing is deliberate: the usual reason a send fails is that the network
 * or the backend is down, which is a fact about the next report as much as about this one. Trying
 * all ten would spend ten timeouts to learn the same thing once, on the foreground transition where
 * the app can least afford it. A 4xx is different — that report is individually unacceptable — so
 * it is discarded and the drain carries on.
 *
 * Returns how many rows left the device. Nothing branches on it; it exists so the drain can say
 * something true and so a spooled crash report's pickup is observable.
 */
export async function flushSpool(getToken: TokenSource): Promise<number> {
  const remaining = await read();
  if (remaining.length === 0) return 0;

  let cleared = 0;
  while (remaining.length > 0) {
    const next = remaining[0];
    if (!next) break;
    const result = await deliver(next, getToken);
    if (!result.gone) break;
    remaining.shift();
    cleared += 1;
  }

  await write(remaining);
  return cleared;
}
