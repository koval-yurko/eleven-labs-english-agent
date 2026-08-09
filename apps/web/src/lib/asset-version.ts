/**
 * Single version stamp for every fixed-URL asset. Bump it to force all user devices to
 * drop their cached copies and refetch:
 *
 * - icon URLs (`layout.tsx` metadata + `manifest.ts`) get `?v=` from here, busting the
 *   immutable HTTP cache on the generated `/pwa/*` PNGs;
 * - the service worker is registered as `/sw.js?v=…` (`ServiceWorkerRegister.tsx`), so a
 *   bump changes the registration URL → the browser installs the "new" worker, whose
 *   activate handler deletes every previous cache (including the precached offline shell,
 *   re-fetched on install).
 *
 * `/_next/static/*` needs no stamp — Next content-hashes those per build.
 */
export const ASSET_VERSION = "3";
