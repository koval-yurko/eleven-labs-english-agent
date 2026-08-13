# S3 — the conversation id and the v2 token route (B3) · research

**Date:** created 2026-08-13 · **Status:** 🔲 **placeholder — not researched.**
**Enrich after: S2's gate is green.**

**Parents:** [build plan → S3](./2026-08-12-expo-build-plan.md) ·
[creation doc §2, §3.4, §9 B3](./2026-08-12-expo-app-creation.md) ·
[S2 research](./2026-08-13-expo-s2-auth0-bearer.md).

---

## Why this file is empty

S3 is the first stage that writes **server** code and touches the **database**, and both depend on
S2's shape: the token route is the first authenticated v2 route, so it inherits whatever
`getBearerOwnerId` turned out to be. Its gate is also the only one that can only be checked _in
Postgres_ — and what to look at there depends on which `conversation_id` the webhook reports, which
nothing before S3 can observe.

## Already decided — do not re-derive

- **The signed-URL path is impossible on RN** (creation doc §2): the SDK throws for
  `connectionType: "websocket"` or `signedUrl`, structurally — the WebSocket path needs `AudioContext`
  / `AudioWorkletNode`. So a v2 sibling calls `/v1/convai/conversation/token`.
- **Do not send `agentId` from the app.** That is the public-agent path, and it compiles agent ids
  into a binary — `pnpm sync:agents` retiring a version would break every installed copy.
  `GET /api/v2/agent-versions` returns version + label with **`agentId` stripped**; the token route
  resolves version → agent id server-side.
- **Dynamic variables are provably identical across transports** — `constructOverrides()` is shared by
  both connections (creation doc §9 B3). `items_list`, `lesson_id`, `app_env` need no changes.
- **The hazard:** WebRTC **derives** `conversationId` (`room_${Date.now()}` placeholder → `room.name`
  match on `/conv_[A-Za-z0-9]+/` → raw room name). Four writers converge on one `lesson_sessions` row
  keyed by that column, so a derived id silently forks history.
- **The mitigation** (M1–M3): the token response carries the authoritative `conversation_id`; seed
  `conversationIdRef` from it **before** `startSession`; `onConnect`'s id is advisory — compare, warn,
  never overwrite.
- **`appEnv` is required, never defaulted** — the post-call webhook routes on it.

## Inputs required from S2

- [ ] The final `getBearerOwnerId` signature and how routes call it
- [ ] Working device→server auth (this stage's route is useless without it)
- [ ] The API base URL the device uses, and how dev vs prod is selected on device

## Questions this research must answer

- [ ] Exact request/response of `/v1/convai/conversation/token` at the current ElevenLabs API version —
      field names, error shapes, and whether `conversation_id` is always present
- [ ] The `packages/shared/src/api.ts` declarations: `ConversationTokenResponse`, the agent-versions
      body, their `API_ROUTES` entries and guards (creation doc §3.4)
- [ ] Where `appEnv` comes from on the server, and what "error rather than default" looks like to the
      client
- [ ] Which id the **post-call webhook** reports for a WebRTC session — the one thing M1–M3 rest on
      and cannot themselves test
- [ ] How to inspect `lesson_sessions` for the gate: the exact query, and what a _forked_ pair of rows
      would look like so it is recognisable
- [ ] Ordering: do overrides land before our kickoff effect fires on `status === "connected"` on
      WebRTC? (Expected yes — both happen inside `createConnection` — but it depends on server-side
      ordering we do not control.)
- [ ] Does `POST /api/v2/lessons/session` reuse `persistTutorSession` as a thin caller, and does it
      need `after()` fast paths (creation doc §3.2)?

## Gate — B3-M4

- [ ] One native session end to end
- [ ] In the database: the row the client wrote and the row the post-call webhook upserts are **the
      same row** — one `lesson_sessions` record, not two
- [ ] That row carries the **correct `app_env`**

The `app_env` check is separate on purpose: a session that lands as one row in the **wrong
environment** passes the row check and is still wrong — discovered much later, when dev sessions turn
up in prod history.

## Enrichment checklist

1. Copy in S2's outputs.
2. Re-read the ElevenLabs SDK source for the `conversationId` derivation at the **installed** version —
   creation doc §9 B3 quotes it as of 2026-08-12; confirm it has not changed before designing around it.
3. Write the route sketches (token, agent-versions, session) and the `api.ts` additions here first.
4. Flip the status line and update the build plan's Progress table.
5. **This is the 🚩 gate stage.** After it, record the explicit go/no-go in the build plan.

## Sources to start from

- creation doc §2, §3.3–3.5, §9 B3 · build plan S3 and the 🚩 gate section
- [ElevenLabs — Get conversation token (WebRTC)](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-webrtc-token)
- [elevenlabs/packages](https://github.com/elevenlabs/packages) — `WebRTCConnection.ts`,
  `WebSocketConnection.ts`, `utils/overrides.ts`
- In-repo: `packages/shared/src/api.ts`, `apps/web/src/lib/tutor-session.ts`,
  `apps/web/src/lib/agent-registry.ts`, `apps/web/src/agent/agents.lock.json`
