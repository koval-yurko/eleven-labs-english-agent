import { waitUntil } from "@vercel/functions";

/**
 * Run `task` after the response, keeping the function alive until it settles — the Hono API's
 * stand-in for Next's `after()`, named the same so the route bodies ported from `apps/web` read
 * unchanged.
 *
 * On Vercel, `waitUntil` extends the invocation until the promise settles. Off Vercel (local
 * `pnpm dev`) there is no request context and the promise simply runs to completion in the
 * long-lived Node process — the same outcome. Verified both ways in the step 0 spike
 * (docs/2026-10-10-services-split-hono-api.md §4.4).
 *
 * The task starts now rather than after the response is flushed (Next's `after` waited). Every
 * caller already does its own work first and schedules only observability or enrichment here, so
 * nothing the response depends on can race it.
 */
export function after(task: () => unknown): void {
  waitUntil(
    (async () => {
      await task();
    })(),
  );
}
