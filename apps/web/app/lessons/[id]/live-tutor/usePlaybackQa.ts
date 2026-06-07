"use client";

import { useCallback, useRef, type RefObject } from "react";

/**
 * Bridges the live exchange to the lesson <audio> element (FR-002/FR-003/FR-010, R6):
 * pause-and-capture the exact position when the learner interrupts, resume from that
 * exact position when the exchange ends, and track a manual-pause flag so a deliberate
 * pause is NOT treated as a question (FR-004) and does not auto-resume.
 */
export function usePlaybackQa(audioRef: RefObject<HTMLAudioElement | null>) {
  const manualPausedRef = useRef(false);

  const isPlaying = useCallback(() => {
    const audio = audioRef.current;
    return Boolean(audio && !audio.paused && !audio.ended);
  }, [audioRef]);

  /** Pause the lesson and return the exact position to resume from later. */
  const captureAndPause = useCallback((): number => {
    const audio = audioRef.current;
    if (!audio) return 0;
    const at = audio.currentTime;
    audio.pause();
    return at;
  }, [audioRef]);

  /** Resume from the captured point — unless the learner had manually paused. */
  const resumeFrom = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio || manualPausedRef.current) return;
      try {
        audio.currentTime = seconds;
      } catch {
        /* setting currentTime can throw before metadata loads; ignore */
      }
      void audio.play().catch(() => {
        /* autoplay can be blocked; the visible controls still allow manual resume */
      });
    },
    [audioRef],
  );

  const setManualPaused = useCallback((value: boolean) => {
    manualPausedRef.current = value;
  }, []);

  return { isPlaying, captureAndPause, resumeFrom, setManualPaused };
}
