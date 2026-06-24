# Contracts: 008-langsmith-tracing

Boundary contracts this feature adds. Three surfaces:

1. **`otel-webhook.openapi.yaml`** — the inbound ElevenLabs post-call webhook route the app
   exposes, and the outbound LangSmith OTLP forward it performs.
2. **`sweep.openapi.yaml`** — the scheduled stale-session finalizer route.
3. **`ports.md`** — the new `LiveStoryRepository` methods + the telemetry envelope Zod
   schema (internal TypeScript contracts, not HTTP).

All HTTP routes follow the existing app conventions (`apps/web/lib/http.ts` helpers,
`apiError(status, code, message)`). The webhook + sweep routes are **not** Auth0-authenticated
(no learner session); they are guarded by a **shared secret** instead (HMAC for the webhook,
a bearer/cron secret for the sweep).
