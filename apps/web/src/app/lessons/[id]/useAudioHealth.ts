"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tell whether the session's audio pipeline is actually alive.
 *
 * On iOS a notification sound, Siri, an incoming call or a Control Centre pull-down moves every
 * `AudioContext` on the page to `"interrupted"`. The ElevenLabs SDK calls `resume()` only while
 * setting a session up (`platform/web/{input,output}.js`) and installs no `statechange` listener,
 * so an interrupted context stays dead for the rest of the session: `status` still reads
 * `"connected"`, the transcript still looks alive, and nobody can hear anybody.
 *
 * We can't reach the SDK's context (`useConversation` exposes volumes, not the graph), so we watch
 * two proxies:
 *
 *   1. A **probe context** created alongside the session. An interruption is a system-level audio
 *      session event — every context in the page flips together — so the probe's state mirrors the
 *      SDK's. This is the authoritative signal.
 *   2. A **volume heartbeat** over the exposed `getInputVolume()` / `getOutputVolume()`. Digital
 *      silence on both for a long stretch while connected means the graph is running but nothing is
 *      flowing through it. Weaker (a genuinely silent room looks similar), so it is reported
 *      separately as `"stalled"` and only ever drives a warning, never an automatic teardown.
 *
 * See docs/2026-08-07-ios-keep-session-alive-foreground.md.
 */

export type AudioHealth = "ok" | "interrupted" | "stalled";

/** How often we sample the probe state and the volumes. */
const POLL_MS = 2000;
/** Consecutive silent samples before we call it stalled (~12s — long enough to outlast a pause). */
const STALL_SAMPLES = 6;
/** Anything below this is digital silence; real mic input never sits exactly at zero. */
const SILENCE_EPS = 1e-4;

export interface AudioHealthResult {
  health: AudioHealth;
  /** Resume the probe context — call from a user gesture (a tap) before restarting the session. */
  resume: () => Promise<void>;
}

export function useAudioHealth({
  active,
  getInputVolume,
  getOutputVolume,
}: {
  active: boolean;
  getInputVolume: () => number;
  getOutputVolume: () => number;
}): AudioHealthResult {
  const [health, setHealth] = useState<AudioHealth>("ok");
  const contextRef = useRef<AudioContext | null>(null);
  // Mirrors so the poll interval doesn't need re-subscribing when the SDK re-renders.
  const inputRef = useRef(getInputVolume);
  const outputRef = useRef(getOutputVolume);
  inputRef.current = getInputVolume;
  outputRef.current = getOutputVolume;

  useEffect(() => {
    if (!active) {
      setHealth("ok");
      return;
    }
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return;

    const context = new AudioContext();
    contextRef.current = context;
    // Same unlock the SDK does: a one-sample silent buffer inside the session-start gesture, so
    // the probe starts `running` instead of `suspended` on iOS.
    try {
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, 22050);
      source.connect(context.destination);
      source.start(0);
    } catch {
      // Non-fatal: the state polling below still works.
    }
    void context.resume().catch(() => {});

    let silentSamples = 0;

    const evaluate = () => {
      // `"interrupted"` is Safari-only and absent from the TS union, hence the widened compare.
      if ((context.state as string) !== "running") {
        silentSamples = 0;
        setHealth("interrupted");
        return;
      }
      let level = 0;
      try {
        level = Math.max(inputRef.current(), outputRef.current());
      } catch {
        // The conversation may be tearing down between renders; treat as no reading.
        return;
      }
      if (level > SILENCE_EPS) {
        silentSamples = 0;
        setHealth("ok");
        return;
      }
      silentSamples += 1;
      setHealth(silentSamples >= STALL_SAMPLES ? "stalled" : "ok");
    };

    const onStateChange = () => evaluate();
    context.addEventListener("statechange", onStateChange);
    const timer = window.setInterval(evaluate, POLL_MS);

    return () => {
      window.clearInterval(timer);
      context.removeEventListener("statechange", onStateChange);
      contextRef.current = null;
      void context.close().catch(() => {});
      setHealth("ok");
    };
  }, [active]);

  // `resume()` does recover an `"interrupted"` context (unlike libraries that only test for
  // `"suspended"`), but the SDK's worklets stay attached to its own broken graph — so the caller
  // resumes the probe and then restarts the session.
  const resume = useCallback(async () => {
    try {
      await contextRef.current?.resume();
      setHealth("ok");
    } catch {
      // The restart is the real recovery; this is just the polite first try.
    }
  }, []);

  return { health, resume };
}
