"use client";

import type { ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronDownIcon } from "./icons";

/**
 * An expandable section, replacing `<details>` / `<summary>`.
 *
 * Two things the native element gets wrong across engines:
 *  - **The marker.** Safari draws it via `::-webkit-details-marker`, Chrome and Firefox via
 *    `::marker`; resetting it takes different CSS per engine. Here it's just an icon we rotate.
 *  - **It doesn't animate anywhere but Chrome.** `::details-content` has been Baseline since
 *    September 2025, but the height interpolation needs `interpolate-size`, which is still
 *    Chromium-only — so in Safari and Firefox a native `<details>` snaps open. Collapsible measures
 *    the panel and publishes `--collapsible-panel-height`, so the same transition runs everywhere.
 *
 * `hiddenUntilFound` is deliberate: it hides the panel with `hidden="until-found"` instead of
 * unmounting it, so browser find-in-page still reaches collapsed text and expands to it — which is
 * something `<details>` gave us for free and would otherwise be a regression. Session transcripts
 * are exactly the sort of thing you Cmd+F for.
 *
 * A client component holding server-rendered children: both `summary` and `children` are rendered on
 * the server by `lessons/[id]/page.tsx` and passed through as props, so nothing here forces the
 * transcript data into the client bundle.
 */
export function Disclosure({
  summary,
  children,
  className,
  style,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <Collapsible.Root className={className} style={style}>
      <Collapsible.Trigger className="disclosure-trigger">
        <ChevronDownIcon size={16} className="disclosure-marker" />
        <span>{summary}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="disclosure-panel" hiddenUntilFound>
        <div className="disclosure-content">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
