/**
 * Post-response work, injected by the transport.
 *
 * `@tutor/server` never imports a framework, so it cannot call Next's `after()` or Vercel's
 * `waitUntil` itself. A caller hands one in: the Next app passes `(task) => after(task)`, the Hono
 * API will pass `(task) => waitUntil(task())`, and a CLI would simply await. A thunk rather than a
 * promise so the work starts when the transport says so — for `after()` that is after the response,
 * exactly as before the split. See docs/2026-10-10-services-split-hono-api.md §2.1.
 */
export type Defer = (task: () => Promise<void>) => void;
