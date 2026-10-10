"use client";

import { useState, useTransition } from "react";
import { bumpItemPopularityAction } from "./actions";
import { Button } from "../Button";
import { Tooltip } from "../Tooltip";

/**
 * +1 this word's popularity — the detail page's only mutation, standing exactly where the favourite
 * star used to (0017).
 *
 * **A control here and a plain number in the list**, deliberately. The star was a control in both
 * places; a counter should not be, because there is no decrement and a mis-tap in a dense list is
 * unrecoverable. One word on one screen, opened on purpose, is the other case.
 *
 * The server returns the count AFTER the bump and that is what renders — no optimistic increment. A
 * counter is not a toggle: an optimistic +1 that raced another device would show a number that was
 * never true, and there is nothing to "revert" to that would fix it. The wait is one round trip on a
 * page the learner is already sitting on.
 */
export function PopularityButton({
  id,
  text,
  initial,
}: {
  id: string;
  text: string;
  initial: number;
}) {
  const [popularity, setPopularity] = useState(initial);
  const [pending, startTransition] = useTransition();

  function bump() {
    startTransition(async () => {
      try {
        const next = await bumpItemPopularityAction(id);
        // Null means no row matched — someone else's id, or a word already deleted. Leaving the
        // number alone is the honest answer; inventing a +1 for a write that did not land is not.
        if (next !== null) setPopularity(next);
      } catch {
        // The count on screen is still the last one the server confirmed.
      }
    });
  }

  return (
    <Tooltip label={`Met ${text} again`}>
      <Button
        variant="icon"
        onClick={bump}
        disabled={pending}
        aria-label={`Met ${text} again — seen ${popularity} ${popularity === 1 ? "time" : "times"}`}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {popularity}
      </Button>
    </Tooltip>
  );
}
