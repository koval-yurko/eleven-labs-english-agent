import { NextResponse } from "next/server";
import type { ApiErrorBody } from "../shared/api";

/**
 * Standard JSON responses + error envelope. The shapes themselves live in `src/shared/api.ts` so
 * any client can name them; this module is the Next-specific half that builds the responses.
 */

export function json<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function apiError(status: number, code: string, message: string): NextResponse {
  const body: ApiErrorBody = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export const unauthorized = () =>
  apiError(401, "unauthenticated", "You must be signed in to do that.");
