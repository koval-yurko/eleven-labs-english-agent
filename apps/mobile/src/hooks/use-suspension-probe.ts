import { useEffect, useState } from "react";

export type SuspensionProbe = {
  /** Seconds iOS has taken from us so far, measured live. */
  drift: number;
  /** The high-water mark. THIS is the number the S1b gate is read from. */
  maxDrift: number;
  /** Wall-clock seconds since the probe started — a session clock to correlate by ear. */
  elapsed: number;
};

const ZERO: SuspensionProbe = { drift: 0, maxDrift: 0, elapsed: 0 };

/**
 * Measures suspension instead of observing it, because you cannot watch a locked screen.
 *
 * A 1s timer increments `ticks` while wall-clock elapsed is read independently. When iOS suspends
 * the app the timer stops and the clock does not, so `wall - ticks` is the number of seconds we
 * were not running.
 *
 * READ `maxDrift`, NEVER `drift`. On resume, either iOS fires nothing that was missed (drift stays
 * elevated) or the runtime coalesces a catch-up burst (drift collapses back toward zero within
 * seconds). Both are plausible, and it does not matter which happens: `maxDrift` is latched at the
 * first tick after resume either way. A screen showing only live `drift`, read a few seconds after
 * unlocking, can show ~0 after a full suspension.
 *
 * Counters live in the effect closure rather than in refs, and every state write happens in a timer
 * callback rather than in the effect body: each run gets a fresh `ticks`/`max` with no reset step to
 * forget, and a stale `maxDrift` can never leak from the previous run into this one's verdict.
 *
 * Keep this after S1 goes green — it is the regression check for every SDK and iOS upgrade that
 * follows. See docs/2026-08-12-expo-build-plan.md appendix A.
 */
export function useSuspensionProbe(running: boolean): SuspensionProbe {
  const [measure, setMeasure] = useState<SuspensionProbe>(ZERO);

  useEffect(() => {
    if (!running) return;

    const startedAt = Date.now();
    let ticks = 0;
    let max = 0;

    const sample = (counted: boolean) => {
      if (counted) ticks += 1;
      const elapsed = (Date.now() - startedAt) / 1000;
      const drift = elapsed - ticks; // ← the measurement
      if (drift > max) max = drift;
      setMeasure({ drift, maxDrift: max, elapsed });
    };

    // An uncounted sample on the next turn of the loop, so the display shows THIS run's zero
    // immediately instead of the previous run's numbers for a second.
    const first = setTimeout(() => sample(false), 0);
    const id = setInterval(() => sample(true), 1000);

    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [running]);

  return measure;
}
