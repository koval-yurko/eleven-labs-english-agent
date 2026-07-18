"use client";

import { useState, useTransition } from "react";
import { setItemFavoriteAction } from "./actions";
import { StarIcon } from "../icons";

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
    <button
      type="button"
      onClick={toggle}
      aria-pressed={isFavorite}
      aria-label={isFavorite ? `Unfavorite ${text}` : `Favorite ${text}`}
      title={isFavorite ? "Remove from favorites" : "Add to favorites"}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        color: isFavorite ? "var(--warn)" : "var(--muted)",
      }}
    >
      <StarIcon state={isFavorite ? "filled" : "empty"} size={18} />
    </button>
  );
}
