import type { ReactNode } from "react";

/**
 * `/ops` — operator surfaces. **Not product, and not linked from anywhere.**
 *
 * `CLAUDE.md` says plainly that `apps/web` is deprecated as a UI and that new screens do not go
 * here. This route group is the one exception, and it is an exception to the SENTENCE rather than
 * to the rule behind it:
 *
 * > `apps/web` is deprecated as a **learner-facing UI** and kept as the backend. Operator
 * > surfaces — pages that exist to inspect data the backend owns — belong to the backend, not to
 * > the deprecated client.
 *
 * The distinction is kept in the filesystem and the routing rather than in a comment, which is why
 * this file exists at all: everything under `/ops` is one directory, nothing under it is reachable
 * from the header in `app/layout.tsx`, and the URL is typed by hand. A page here is a database
 * viewer that happens to render in a browser.
 *
 * The line that legitimises it is in `CLAUDE.md`. Without it the next person reads this directory
 * as a violation and either deletes it or — worse — adds a learner page beside it.
 *
 * See docs/2026-09-09-mobile-debug-reports-and-feedback.md §12.1 (settled 2026-09-09, D12).
 */
export default function OpsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Operator — not part of the app. Nothing here is linked from the learner navigation.
      </p>
      {children}
    </>
  );
}
