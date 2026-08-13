import { useCallback, useState } from "react";

/**
 * `you` and `agent` are separate kinds rather than one "transcript" kind on purpose: gate criterion
 * 4 (uplink) is answered by counting `you` lines inside the locked window, and that has to be
 * readable at a glance on a screen you are looking at for the first time after unlocking.
 */
export type LogKind = "you" | "agent" | "status" | "appstate" | "error" | "note";

export type LogEntry = {
  id: number;
  /** Wall-clock HH:MM:SS — you compare this against the time you locked the phone. */
  at: string;
  kind: LogKind;
  text: string;
};

/** Enough to cover a 3-minute test with room to spare; bounded so a long run cannot grow forever. */
const MAX_ENTRIES = 400;

let nextId = 0;

function clockTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The scrollback that makes a locked-screen test readable after unlocking.
 *
 * NEWEST FIRST, deliberately: after a lock you want the gap and what followed it at the top of the
 * screen, not three minutes of scrolling away. Timestamps are wall-clock rather than relative,
 * because gate criterion 4 ("transcript lines timestamped during the locked window") can only be
 * checked against the clock you locked the phone by.
 *
 * No file logging and no log shipping, on purpose. Both outcomes are already readable here: if iOS
 * SUSPENDED the app, this state survives and the gap is visible; if iOS TERMINATED it, you unlock
 * to an empty scrollback, which is itself an unambiguous — and worse — result.
 */
export function useEventLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  const log = useCallback((kind: LogKind, text: string) => {
    const entry: LogEntry = { id: nextId++, at: clockTime(), kind, text };
    setEntries((prev) => [entry, ...prev].slice(0, MAX_ENTRIES));
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  return { entries, log, clear };
}
