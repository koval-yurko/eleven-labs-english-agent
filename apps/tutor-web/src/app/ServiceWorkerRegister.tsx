"use client";

import { useEffect } from "react";
import { ASSET_VERSION } from "../lib/asset-version";

/** Ask the browser to keep our storage durable, so iOS/Safari don't evict the offline cache +
 *  the IndexedDB mirror after ~7 idle days (the doc's iOS storage-eviction reality check). Safe
 *  and idempotent: only requests when not already persisted; failure is ignored. Runs in all
 *  envs (the mirror exists in dev too), independent of the production-only SW registration. */
function requestPersistentStorage() {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
  void navigator.storage
    .persisted()
    .then((already) => (already ? undefined : navigator.storage.persist()))
    .catch(() => {});
}

/**
 * Registers the hand-rolled service worker (`public/sw.js`) so the installed PWA opens offline,
 * and requests durable storage for the offline cache + mirror. SW registration is production-only
 * (in dev an active SW caching assets just gets in the way, and the SW is only useful against a
 * real build) and happens after `load` to avoid competing with first paint. Renders nothing.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    requestPersistentStorage();

    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      // The ?v= makes the script URL part of the asset version: bumping ASSET_VERSION
      // installs a fresh worker, which purges every previous cache on activate.
      void navigator.serviceWorker.register(`/sw.js?v=${ASSET_VERSION}`).catch(() => {
        // A failed registration must never break the app — offline is a progressive enhancement.
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
