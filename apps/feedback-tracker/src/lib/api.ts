import type { ApiErrorBody } from "@tutor/shared/api";

import { auth0 } from "./auth0";

/**
 * feedback-tracker's ONE way to data: services/api, over HTTP, as the signed-in operator.
 *
 * Server-side only (it reads the Auth0 session and `API_BASE_URL`) — called from server
 * components, server actions and the two same-origin route handlers. The browser never talks to
 * services/api directly and never holds the access token. feedback-tracker has no Supabase key, no
 * vendor key and no `@tutor/server` (D6, docs/2026-10-10-services-split-hono-api.md §5).
 */

/** A non-2xx answer from services/api, with its `ApiErrorBody` envelope unpacked. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiBaseUrl(): string {
  const base = process.env.API_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("API_BASE_URL is not set — feedback-tracker cannot reach services/api.");
  return base;
}

/** The learner's access token for services/api, or null when nobody is signed in. */
export async function accessToken(): Promise<string | null> {
  try {
    const { token } = await auth0.getAccessToken();
    return token ?? null;
  } catch {
    return null;
  }
}

/** Raw call: the API's `Response`, untouched. For the same-origin routes that forward one. */
export async function apiRequest(
  path: string,
  init: { method?: string; body?: BodyInit | null; contentType?: string } = {},
): Promise<Response> {
  const token = await accessToken();
  if (!token) {
    const body: ApiErrorBody = {
      error: { code: "unauthenticated", message: "You must be signed in to do that." },
    };
    return Response.json(body, { status: 401 });
  }
  return fetch(`${apiBaseUrl()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.contentType ? { "content-type": init.contentType } : {}),
    },
    body: init.body ?? null,
    // Owner-scoped, live data: never let Next's fetch cache hold one learner's answer.
    cache: "no-store",
  });
}

/** JSON call. Throws `ApiError` on any non-2xx, so a page can `notFound()` on 404. */
export async function apiFetch<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await apiRequest(path, {
    method: init.method,
    body: init.json === undefined ? null : JSON.stringify(init.json),
    contentType: init.json === undefined ? undefined : "application/json",
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const envelope = body as Partial<ApiErrorBody> | null;
    throw new ApiError(
      res.status,
      envelope?.error?.code ?? "http",
      envelope?.error?.message ?? `services/api answered HTTP ${res.status}`,
    );
  }
  return body as T;
}

/** `apiFetch`, with a 404 turned into null — for detail pages that `notFound()` on a miss. */
export async function apiFetchOrNull<T>(path: string): Promise<T | null> {
  try {
    return await apiFetch<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
