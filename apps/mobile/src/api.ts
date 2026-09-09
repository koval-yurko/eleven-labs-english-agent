import { isApiError } from "@tutor/shared/api";

import { emit } from "./lib/diagnostics";
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

  const startedAt = Date.now();
  const method = init?.method ?? "GET";
  let res: Response;
  try {
    res = await send(false);
  } catch (e) {
    /**
     * The request never got an answer: no DNS, no route, or `getToken` refused.
     *
     * `path` and nothing else. The token routes' BODIES are the least safe thing in this app and
     * every request's headers carry a bearer token; the path is safe and is the interesting part.
     * The credential therefore never enters the bus and there is nothing for the redactor to catch
     * — see §6 of docs/2026-09-09-mobile-debug-reports-and-feedback.md.
     */
    emit({
      level: "error",
      code: "api.failed",
      message: e instanceof Error ? e.message : String(e),
      data: { path, method, ms: Date.now() - startedAt },
    });
    throw e;
  }

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
    // The retry is invisible on screen by design — it exists so a lesson does not die on a clock
    // skew. Logging it is how a token being renewed on EVERY request stops looking like a healthy
    // session.
    emit({ level: "warn", code: "api.retry_401", message: "401 — retrying with a fresh token", data: { path } });
    try {
      res = await send(true);
    } catch {
      // Keep `res` — the original 401 — and fall through to the error envelope below.
    }
  }

  const body: unknown = await res.json().catch(() => null);

  const ms = Date.now() - startedAt;

  if (!res.ok || isApiError(body)) {
    const failure = isApiError(body)
      ? new ApiFetchError(res.status, body.error.message, body.error.code)
      : new ApiFetchError(res.status, `HTTP ${res.status}`);
    emit({
      level: "error",
      code: "api.failed",
      message: failure.message,
      data: { path, method, status: res.status, code: failure.code ?? null, ms },
    });
    throw failure;
  }

  emit({
    // `debug`, not `info`: a successful request is the sequence, not the story. The ring's eviction
    // rule spends these first, which is exactly right — they are what reconstructs the ORDER of
    // events around a failure, and they are worth nothing once the failure itself has been dropped.
    level: "debug",
    code: "api.request",
    message: `${method} ${path} → ${res.status}`,
    data: { path, method, status: res.status, ms },
  });

  return body as T;
}
