import { NextResponse } from "next/server";

/** Standard JSON responses + error envelope (contracts/http-api.md). */

export function json<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function apiError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export const unauthorized = () =>
  apiError(401, "unauthenticated", "You must be signed in to do that.");

export const notFound = () => apiError(404, "not_found", "Lesson not found.");
