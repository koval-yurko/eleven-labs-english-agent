/**
 * Browser-safe entry point: `@idiomatic/live-story/client`.
 *
 * Only the pure modules that a React client needs — the narration state machine, the client
 * tools over it, the per-session grounding, and the prompt artifact. These depend solely on
 * `@idiomatic/contracts`, so importing this from `"use client"` code never pulls the
 * server-only services (and thus `@idiomatic/generator` → `@anthropic-ai/sdk`, which uses
 * `node:fs`) into the browser bundle.
 *
 * Server code (composition root, API routes, Supabase repo) imports the full surface from the
 * package root (`@idiomatic/live-story`) instead.
 */
export * from "./agent/agent-prompt";
export * from "./agent/client-tools";
export * from "./agent/plan-context";
export * from "./narration/narration-state";
