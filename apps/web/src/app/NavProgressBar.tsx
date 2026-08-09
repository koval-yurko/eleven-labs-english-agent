"use client";

import { useEffect, useState } from "react";
import { useNavigationPending } from "./nav-progress";

/**
 * Don't flash the bar for navigations that resolve almost immediately (prefetched, or a route
 * whose data is already in the router cache). This is the one timer in the feature and it only
 * ever *hides* the bar — it never advances it.
 */
const SHOW_AFTER_MS = 120;

/** Matches the completion fade in globals.css. */
const FADE_MS = 260;

type State = "idle" | "loading" | "done";

/**
 * The YouTube-style bar across the top of the page.
 *
 * It is deliberately **indeterminate** while loading. Today a navigation is a single opaque
 * server render — one request, ~9-18kb, ~4ms of download — so there is no honest percentage to
 * show, and a trickling fake would be worse than an animation that just says "working". Adding
 * `loading.tsx` + `Suspense` boundaries (phase 3 in
 * docs/2026-07-26-navigation-progress-bar.md) is what creates real checkpoints to step on.
 *
 * Renders nothing on the server and nothing on the first client render, so it cannot introduce a
 * hydration mismatch — the failure mode that broke the theme in
 * docs/2026-07-26-light-theme-reverts-to-dark-on-navigation.md.
 */
export function NavProgressBar() {
  const pending = useNavigationPending();
  const [state, setState] = useState<State>("idle");

  useEffect(() => {
    if (pending) {
      // A navigation starting while the previous bar is still fading: keep it on screen rather
      // than blinking through idle.
      setState((current) => (current === "done" ? "loading" : current));
      const timer = setTimeout(() => setState("loading"), SHOW_AFTER_MS);
      return () => clearTimeout(timer);
    }
    // Settled. Only complete a bar the user actually saw — one that never passed the reveal
    // delay stays idle and shows nothing at all.
    setState((current) => (current === "loading" ? "done" : current));
  }, [pending]);

  useEffect(() => {
    if (state !== "done" || pending) return;
    const timer = setTimeout(() => setState("idle"), FADE_MS);
    return () => clearTimeout(timer);
  }, [state, pending]);

  if (state === "idle") return null;

  return (
    <div
      className="nav-progress"
      data-state={state}
      // Indeterminate: a progressbar with no aria-valuenow is exactly that, and claiming a
      // percentage we don't have would be the same lie visually as it is to a screen reader.
      role="progressbar"
      aria-label="Loading page"
      aria-busy={state === "loading"}
    >
      <div className="nav-progress__bar" />
    </div>
  );
}
