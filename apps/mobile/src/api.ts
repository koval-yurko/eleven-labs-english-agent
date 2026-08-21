import { isApiError } from "@tutor/shared/api";

import { env } from "./env";

/**
 * The one way this app talks to `/api/v2/*`.
 *
 * Four steps that are identical at every call site — resolve a fresh token, prefix the base URL,
 * attach the Bearer header, narrow the error envelope — collected here before there are four copies
 * of them. See docs/2026-08-13-expo-s3-conversation-token.md §6.2.
 */

/** Thrown for any non-2xx response, carrying the server's `ApiErrorBody` message when there is one. */
export class ApiFetchError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiFetchError";
    this.status = status;
    this.code = code;
  }
}

/**
 * A function that yields a current access token, or null when signed out.
 *
 * Passed in rather than imported so this module stays free of React: the real implementation is
 * `useAccessToken()` from `lib/auth.tsx`, which is a hook value.
 *
 * IMPORTANT: it must be called PER REQUEST, never cached in a module. It is the call that renews
 * the token silently (S2 §5); a token captured once at login is a session that dies mid-lesson an
 * hour later.
 *
 * `forceRefresh` skips the cached token and renews unconditionally. Only the 401 retry below passes
 * it, and only once — see there for why.
 */
export type TokenSource = (options?: { forceRefresh?: boolean }) => Promise<string | null>;

export async function apiFetch<T>(
  path: string,
  getToken: TokenSource,
  init?: RequestInit,
): Promise<T> {
  const send = async (forceRefresh: boolean): Promise<Response> => {
    const token = await getToken({ forceRefresh });
    if (!token) throw new ApiFetchError(0, "Not signed in.");

    // `env.apiBaseUrl` THROWS when unset rather than defaulting (src/env.ts) — a build pointing at
    // nothing should fail loudly at the first call, not silently request a relative path.
    return fetch(`${env.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  };

  let res = await send(false);

  /**
   * One retry with a freshly minted token when the server rejected this one.
   *
   * The two clocks disagree: a token the credentials manager still considers current can already be
   * expired at the server, and a lesson that dies on a single 401 is the failure this app cannot
   * afford. Exactly one retry, and only for 401 — a second rejection is an answer, not a race.
   *
   * The renewal is allowed to fail without replacing the error: if the session cannot be renewed,
   * the token source has already ended it (`lib/auth.tsx`) and the app is on its way to the sign-in
   * screen, so the honest thing to report here is still the server's 401.
   */
  if (res.status === 401) {
    try {
      res = await send(true);
    } catch {
      // Keep `res` — the original 401 — and fall through to the error envelope below.
    }
  }

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok || isApiError(body)) {
    if (isApiError(body)) throw new ApiFetchError(res.status, body.error.message, body.error.code);
    throw new ApiFetchError(res.status, `HTTP ${res.status}`);
  }

  return body as T;
}
