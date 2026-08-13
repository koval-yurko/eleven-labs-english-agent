"use client";

import { useEffect, useRef, useState } from "react";
import NoSleep from "@zakj/no-sleep";

/**
 * Hold the screen awake for the duration of a tutor session — and say so out loud when it fails.
 *
 * The ElevenLabs SDK already requests a screen wake lock (`useWakeLock`, default on), but it
 * swallows a failed request AND only installs its re-acquire handler when the *first* request
 * succeeded. One early failure therefore means no wake lock for the rest of the session, with
 * nothing in the UI to say so — and on iOS a locked screen kills the session outright (see
 * docs/2026-08-12-expo-app-creation.md). So we pass `useWakeLock: false` to
 * `startSession` and own it here instead, where we can retry unconditionally and report state.
 *
 * Two ladders down:
 *   1. Screen Wake Lock API — the real thing. Secure contexts only (HTTPS or localhost); Safari
 *      16.4+, and broken in installed PWAs before iOS 18.4.
 *   2. @zakj/no-sleep (the maintained NoSleep.js fork). It picks a looping inline video — iOS keeps
 *      the display alive while a video plays — precisely where Wake Lock is missing or known
 *      broken (no `navigator.wakeLock`; installed PWA before iOS 18.4). Where the API exists but
 *      the *request* fails (a non-secure origin), the library reaches for Wake Lock too and fails
 *      identically, which is why its `enabled` flag is checked rather than assumed.
 *   3. Nothing, with an explanation the user can act on.
 *
 * Note the first failure mode we hit in practice: testing on a phone against a bare LAN address
 * (`http://192.168.x.x:3000`) is not a secure context, so Wake Lock throws and the phone locks
 * mid-lesson — which reads as "the tutor randomly dies on iPhone but is fine on my laptop".
 */

export type KeepAwakeMethod = "wake-lock" | "video" | "none";

export interface KeepAwakeState {
  /** How the screen is being held awake right now. */
  method: KeepAwakeMethod;
  /** Why it is NOT being held awake — user-facing, `null` while it is. */
  reason: string | null;
}

/** Minimal shape of the Screen Wake Lock API; typed locally so we don't depend on lib.dom having it. */
interface WakeLockSentinelLike extends EventTarget {
  released: boolean;
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

const IDLE: KeepAwakeState = { method: "none", reason: null };

function noWakeLockReason(): string {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "This page is not on HTTPS, so the browser refuses to keep the screen awake — the phone will lock and end the session. Use an HTTPS tunnel or a preview deploy when testing on a phone.";
  }
  return "This browser will not keep the screen awake. Turn off Auto-Lock (Settings → Display & Brightness) or tap the screen now and then, or the session will end when the phone locks.";
}

/**
 * Keeps the display awake while `enabled`. Re-acquires whenever the page becomes visible again
 * (a wake lock is always released when the page hides) and on the next user gesture after a
 * failure, since the video fallback needs playback permission that a gesture reliably grants.
 */
export function useKeepAwake(enabled: boolean): KeepAwakeState {
  const [state, setState] = useState<KeepAwakeState>(IDLE);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);
  const noSleepRef = useRef<InstanceType<typeof NoSleep> | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // Mirror of `state.method` for the listeners below, which are registered once per session and
  // would otherwise close over the first render's value.
  const methodRef = useRef<KeepAwakeMethod>("none");

  function apply(next: KeepAwakeState) {
    methodRef.current = next.method;
    setState(next);
  }

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function acquire() {
      if (cancelled || !enabledRef.current) return;
      if (sentinelRef.current && !sentinelRef.current.released) return;

      const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
      if (wakeLock) {
        try {
          const sentinel = await wakeLock.request("screen");
          if (cancelled || !enabledRef.current) {
            void sentinel.release().catch(() => {});
            return;
          }
          sentinelRef.current = sentinel;
          // The browser releases the lock on its own (page hidden, battery saver); reflect that
          // rather than keep claiming the screen is held.
          sentinel.addEventListener("release", () => {
            if (sentinelRef.current === sentinel) sentinelRef.current = null;
            if (enabledRef.current) apply({ method: "none", reason: noWakeLockReason() });
          });
          apply({ method: "wake-lock", reason: null });
          return;
        } catch {
          // Fall through to the video fallback.
        }
      }

      try {
        const noSleep = (noSleepRef.current ??= new NoSleep());
        // `enable()` is async and swallows its own failures, so the `enabled` flag — not the
        // absence of a throw — is what says whether the display is actually being held.
        await Promise.resolve(noSleep.enable() as unknown);
        if (cancelled || !enabledRef.current) return;
        apply(
          noSleep.enabled
            ? { method: "video", reason: null }
            : { method: "none", reason: noWakeLockReason() },
        );
      } catch {
        apply({ method: "none", reason: noWakeLockReason() });
      }
    }

    // A wake lock is dropped every time the page hides, so re-take it on the way back —
    // unconditionally, unlike the SDK, which only retries when its first attempt worked.
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    // The video fallback can be refused without a gesture; the next tap is our second chance.
    const onGesture = () => {
      if (methodRef.current === "none") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("pointerdown", onGesture, { passive: true });

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerdown", onGesture);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      void sentinel?.release().catch(() => {});
      noSleepRef.current?.disable();
      apply(IDLE);
    };
    // Deliberately keyed on `enabled` alone: `apply` and the refs it writes change on every render,
    // and depending on them would tear the acquire loop down and re-take the lock constantly.
  }, [enabled]);

  return state;
}
