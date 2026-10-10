"use client";

import Link, { useLinkStatus, type LinkProps } from "next/link";
import { useEffect, type AnchorHTMLAttributes, type ReactNode } from "react";
import { beginNavigation } from "./nav-progress";

/**
 * Reports its `<Link>`'s pending state to the shared store. `useLinkStatus` only works *inside* a
 * `<Link>`, so the top bar — which lives in the layout — can't read it directly; every NavLink
 * renders one of these instead. Emits no DOM of its own.
 */
function PendingReporter() {
  const { pending } = useLinkStatus();

  useEffect(() => {
    if (!pending) return;
    // Cleanup runs when `pending` flips back to false (the navigation committed) or when this
    // link unmounts because the new route replaced the old one — both are the real end.
    return beginNavigation();
  }, [pending]);

  return null;
}

type NavLinkProps = Omit<LinkProps, "href"> &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    children: ReactNode;
  };

/**
 * The app's internal link: a `next/link` that drives the top progress bar.
 *
 * Use it for every in-app route. Plain `<a>` remains correct for anything that must leave the
 * Next router — `/auth/*`, `/api/*`, and the offline shell (see the note on `onNavigate` below).
 */
export function NavLink({ children, href, onNavigate, ...props }: NavLinkProps) {
  return (
    <Link
      {...props}
      href={href}
      onNavigate={(event) => {
        // Offline, a client-side navigation fetches an RSC payload — which `public/sw.js` does
        // not intercept, since it only handles requests with `mode === "navigate"`. The fetch
        // would fail and surface a router error instead of the offline shell. Fall back to a real
        // document navigation so the service worker can answer it.
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          event.preventDefault();
          window.location.href = href;
          return;
        }
        onNavigate?.(event);
      }}
    >
      {children}
      <PendingReporter />
    </Link>
  );
}
