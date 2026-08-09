"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { beginNavigation } from "./nav-progress";
import { useOnline } from "./useOnline";
import { RefreshIcon } from "./icons";
import { Button } from "./Button";
import { Tooltip } from "./Tooltip";

/**
 * Re-read the current page from the server.
 *
 * It exists because enrichment is asynchronous: a word's CEFR level and its `details` payload are
 * filled in *after* the write, by `after()` and by the sweeps (see
 * docs/2026-07-16-level-assignment-background-job.md and
 * docs/2026-07-18-word-details-enrichment-job.md). The `revalidatePath` in `addWordAction` fires
 * before either job has produced anything, so nothing on screen can become correct on its own —
 * this is the learner's way to ask again.
 *
 * `router.refresh()` and NOT `location.reload()`, deliberately: it re-runs the server component and
 * streams new props into the mounted tree, so client state survives. On `/lesson-items` that state
 * includes the multi-select map, which is explicitly designed to accumulate ticked words across
 * several filtered views — a reload would silently throw away a half-built lesson.
 *
 * Disabled offline rather than left to fail: an RSC fetch is not intercepted by `public/sw.js`
 * (it only handles `mode === "navigate"`), so offline it surfaces a router error. `NavLink` escapes
 * that with a real document navigation; a refresh has no equivalent escape — there is no document to
 * fall back to that would be any fresher.
 */
export function RefreshButton({ label = "Refresh" }: { label?: string }) {
  const router = useRouter();
  const online = useOnline();
  const [pending, startTransition] = useTransition();
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  // Same reporter pattern as NavLink's `PendingReporter`: the top progress bar lives in the layout
  // and can only learn about this navigation through the shared store.
  useEffect(() => {
    if (!pending) return;
    return beginNavigation();
  }, [pending]);

  // A refresh that finds nothing new is indistinguishable from a dead button, so say when we last
  // asked. Not "updated" — this reports the question, not an answer we haven't compared.
  const wasPending = useRef(false);
  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (!wasPending.current) return;
    wasPending.current = false;
    setCheckedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }, [pending]);

  function refresh() {
    setCheckedAt(null);
    startTransition(() => router.refresh());
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
      {/* Why the button is dead, and when we last asked — both here rather than in the tooltip. A
          disabled <button> fires no pointer events, so a tooltip on one never opens; and `Tooltip`'s
          own rule is that content a touch user would lose isn't a tooltip in the first place. */}
      <span className="muted" role="status" style={{ fontSize: "0.85rem" }}>
        {!online ? "offline" : checkedAt ? `checked ${checkedAt}` : ""}
      </span>
      <Tooltip label={label}>
        <Button
          variant="icon"
          onClick={refresh}
          disabled={pending || !online}
          aria-label={label}
          // `aria-busy` rather than a second status line: the control announces its own state, and
          // the line beside it stays the report of the *previous* refresh.
          aria-busy={pending}
        >
          <RefreshIcon size={18} className={pending ? "spin" : undefined} />
        </Button>
      </Tooltip>
    </span>
  );
}
