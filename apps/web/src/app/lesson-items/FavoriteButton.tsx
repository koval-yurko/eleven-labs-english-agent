"use client";

import { useState, useTransition } from "react";
import { setItemFavoriteAction } from "./actions";
import { StarIcon } from "../icons";
import { Button } from "../Button";
import { Tooltip } from "../Tooltip";

/**
 * Mark/unmark one item as a favorite — the only mutation on this page.
 *
 * Optimistic and self-contained: the star flips immediately and reverts if the write fails. Local
 * state (not the server prop) is what renders, so the star doesn't flicker back while the page
 * revalidates. Online-only — favoriting isn't an outbox op yet (phase 2).
 */
export function FavoriteButton({
  normKey,
  text,
  initial,
}: {
  normKey: string;
  text: string;
  initial: boolean;
}) {
  const [isFavorite, setIsFavorite] = useState(initial);
  const [, startTransition] = useTransition();

  function toggle() {
    const next = !isFavorite;
    setIsFavorite(next); // optimistic
    startTransition(async () => {
      try {
        await setItemFavoriteAction(normKey, next);
      } catch {
        setIsFavorite(!next); // the write didn't land — put the star back
      }
    });
  }

  return (
    <Tooltip label={isFavorite ? "Remove from favorites" : "Add to favorites"}>
      <Button
        variant="icon"
        onClick={toggle}
        aria-pressed={isFavorite}
        aria-label={isFavorite ? `Unfavorite ${text}` : `Favorite ${text}`}
        // State colour, so it stays inline rather than becoming a variant of its own.
        style={{ color: isFavorite ? "var(--warn)" : "var(--muted)" }}
      >
        <StarIcon state={isFavorite ? "filled" : "empty"} size={18} />
      </Button>
    </Tooltip>
  );
}
