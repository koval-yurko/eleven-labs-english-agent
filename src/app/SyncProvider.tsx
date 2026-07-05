"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { flushOutboxNow } from "../lib/sync/engine";

/**
 * Owns the outbox flush lifecycle for the whole app (there is one of these, mounted in the
 * layout). Flushes on load, on reconnect (`online`), when the tab becomes visible, and whenever
 * an island requests it after a write (`sync:flush`). iOS has no Background Sync, so these
 * foreground triggers are the primary path, not a fallback. After anything is applied, refreshes
 * the current route so the RSC re-renders and the read islands reseed the mirror from server
 * truth. Renders nothing.
 */
export function SyncProvider() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const flush = async () => {
      const applied = await flushOutboxNow();
      if (!cancelled && applied > 0) router.refresh();
    };

    void flush(); // drain anything left from a previous (offline) session

    // Warm the offline app-shell's JS chunks while we have a connection, so a cold offline open
    // has them cached (the SW cache-firsts /_next/static; this makes the request happen). Harmless
    // to call repeatedly — the router dedupes.
    if (typeof navigator === "undefined" || navigator.onLine) router.prefetch("/offline");

    const onOnline = () => void flush();
    const onVisible = () => {
      if (document.visibilityState === "visible") void flush();
    };
    const onRequest = () => void flush();

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("sync:flush", onRequest);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("sync:flush", onRequest);
    };
  }, [router]);

  return null;
}
