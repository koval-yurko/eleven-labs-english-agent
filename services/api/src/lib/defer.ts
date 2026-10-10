import type { Defer } from "@tutor/server/defer";

import { after } from "./after";

/**
 * `@tutor/server`'s post-response hook, on Hono/Vercel: `waitUntil` underneath (see `./after`).
 * Named like the Next app's so the ported routes read unchanged.
 */
export const deferAfter: Defer = (task) => after(task);
