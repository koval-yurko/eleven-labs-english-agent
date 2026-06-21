/**
 * `@idiomatic/live-story` — the adaptive live-narrated story subsystem (006-adaptive-live-story).
 *
 * Owns the agent prompt (versioned source of truth), the pure narration state machine, the
 * client tools over it, plan-context grounding, the transcript persistence boundary + an
 * in-memory impl, and the server-side start/transcript services. Platform glue (Next.js
 * routes, React hooks, Supabase repository, env reading) stays in the web app, which wires
 * its `LessonRepository` into the narrow `LessonReader` port exposed here.
 *
 * Source is grouped by concern: agent/ · narration/ · services/ · persistence/ + types.ts.
 */

// agent/ — the ElevenLabs agent contract: prompt, client tools, per-session grounding
export * from "./agent/agent-prompt";
export * from "./agent/client-tools";
export * from "./agent/plan-context";

// narration/ — the pure core state machine
export * from "./narration/narration-state";

// services/ — server-side orchestration + conversation-token mint
export * from "./services/start-story-service";
export * from "./services/transcript-service";
export * from "./services/token";

// persistence/ — transcript storage boundary + in-memory impl
export * from "./persistence/repository";
export * from "./persistence/in-memory-repository";

// types.ts — the contracts the host app provides: Clock/IdGenerator, LessonReader, LiveStoryConfig
export * from "./types";
