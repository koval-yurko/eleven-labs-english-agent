# How the per-lesson grant authorizes the tutor's write

**Date:** 2026-09-25 · **Resolves:** open question 1 of `docs/2026-09-20-livekit-spike-task-plan.md`
(lines 31-43) · **Parent research:** `docs/2026-09-11-livekit-claude-diy-provider.md` §1, §3.10, §5.2 ·
**Supersedes for the LiveKit path only:** the authorization half of
`docs/2026-08-27-mcp-static-token-auth.md` §2 (anonymous writes). That document stays the decision of
record for the three shipped providers.

## The question

The research doc specs a per-lesson `grant` — an HMAC over `{conversationId, ownerId, exp}`, signed by
the token route — and says it replaces `MCP_TOKEN` entirely (§10.1). It never says how the *tool call*
validates it. Today `add_words_to_collection` reaches Supabase through a shared static token and writes
with `owner_id = NULL`:

- `/api/mcp` authenticates with one static bearer and **deliberately resolves no identity**:
  "This module answers ONE question … returns a boolean. It deliberately does not build an `AuthInfo`,
  does not resolve an owner, and attaches nothing to the request" (`apps/web/src/lib/mcp/auth.ts:8-12`).
- So the tool has no owner to stamp and stamps nothing: `const ANONYMOUS = null;`
  (`apps/web/src/lib/mcp/add-words.ts:40`), then `addWords(ANONYMOUS, words)` (`:78`).
- ElevenLabs sends no per-conversation identity on the MCP hop either — one workspace-level
  `Authorization` secret, no `conversation_id`, no dynamic variables (`apps/web/src/agent/elevenlabs-mcp.ts:240`).

Phase 1 skipped exercising the tool rather than exercise that path. Phase 3 can't.

## What I considered

**A. Teach `/api/mcp` to accept the grant alongside `MCP_TOKEN`.** The worker calls the existing MCP
server, with a grant-derived header, and the server resolves an owner from it.

Rejected. It reverses `docs/2026-08-27-mcp-static-token-auth.md` §2 wholesale — that document *deleted*
a six-link owner chain (`token → verifyMcpToken → AuthInfo.extra.ownerId → req.auth → ctx.http.authInfo
→ mcpOwnerId(ctx) → owner_id`) and would need every link back, for one caller. It also breaks that
document's §8.3 rule in the same commit that restores it: "**No second way in.** One header, one
scheme." Two credential formats on one unauthenticated-by-default endpoint is exactly the shape §3 warns
about, where a client "connects 'successfully'" against a server that half-agrees with it.

**B. The worker doesn't use MCP at all.** ✅ **Chosen** — see below.

**C. Defer every write to session end.** The worker records the intent in the `TurnRecord` ledger and
the session-end route applies it in one grant-verified batch.

Rejected as the primary path, with one piece kept. The tutor cannot truthfully say "added" when nothing
has been; `add-words.ts:56-62` returns `{added, already_present, skipped}` precisely so the prompt can
react to a word the learner already has. Deferring also means a worker crash silently loses the lesson's
saves, and it is the failure the learner would most notice. **Kept from it:** the ledger records each
call anyway, so the session-end route can reconcile what the tool claimed against what landed.

## The decision: the tool is a worker-local tool, not an MCP tool

**MCP exists in this system because ElevenLabs, OpenAI and Vapi host the agent and cannot run our
code.** `/api/mcp` is the seam that lets a third-party runtime call into our backend. The LiveKit worker
is our code — Phase 1 built our own Claude adapter, so the worker already owns the `tools` array it
sends to Anthropic. It has no need of a protocol designed to reach across a vendor boundary.

So: `add_words_to_collection` becomes a **local tool in the worker**, whose handler is one authenticated
HTTP call to a new backend route. Nothing about `/api/mcp` changes, `MCP_TOKEN` stays out of the worker,
and the owner is stamped because the route knows who the learner is.

```text
learner speech → Claude (worker) → tool call
                                     └─ POST /api/v2/livekit/collection-items
                                        Authorization: Bearer <grant>
                                          └─ verifyLessonGrant → ownerId
                                             └─ addWords(ownerId, words)   ← the same data layer
                                                                              /api/v2/lesson-items uses
```

### 1. The grant is a signed JWT, not a bespoke HMAC

The repo has no `createHmac` anywhere in source, but it already mints exactly this kind of credential
with `jose`: `apps/web/src/app/api/v2/words-agent/vapi-token/route.ts:122-136` signs an HS256 JWT with a
1-hour TTL. A JWT *is* an HMAC over a payload, with `exp` handling and a constant-time verify for free,
and it is the pattern a reader of this repo already knows.

```ts
// apps/web/src/lib/auth/lesson-grant.ts — new, used by BOTH new routes
export async function signLessonGrant(p: { conversationId: string; ownerId: string }): Promise<string>;
export async function verifyLessonGrant(req: Request): Promise<{ conversationId: string; ownerId: string } | null>;
```

- `alg: "HS256"`, key `LIVEKIT_GRANT_SECRET` (already minted, already in both `.env.example` files).
- Claims: `sub` = the Auth0 `sub` (the owner), `cid` = `conversationId`, `aud: "livekit-worker"`,
  `iss: "tutor-web"`, `exp`. The audience claim is what stops a grant being replayed at any other route
  that might later verify with the same secret.
- **TTL: 2 hours.** A 20-minute lesson plus pauses, plus the session-end write that lands after it.
- **Fails closed when `LIVEKIT_GRANT_SECRET` is unset**, mirroring `bearer.ts:44` ("misconfigured server
  fails CLOSED, never open") and `auth.ts:75`.

### 2. Why the grant's `ownerId` is trusted, when the webhooks' metadata is not

Both post-call webhooks deliberately take ownership from the lesson row, never from what the client
sent: "dynamic variables come from the browser and are never trusted for ownership"
(`elevenlabs-webhook/route.ts:113-116`), `ownerId: lesson.owner_id` (`v2/vapi/webhook/route.ts:156-157`).

That rule is about **unsigned** client-supplied data. The grant is different in kind: our token route
mints it from the Auth0 `sub` it just verified via `withBearer`, signs it with a secret only the backend
holds, and the receiving route verifies that signature. A learner who edits the grant produces a token
that fails verification. It is the same trust model as `withBearer` itself, with our own key instead of
Auth0's.

The learner's device *can read* the grant (§3.10: dispatch metadata rides in a signed-not-encrypted JWT
claim), so it learns its own `ownerId` and `conversationId` — which it already has — and can replay the
grant against this one route for two hours. The blast radius of that replay is "the learner adds words
to their own collection", which is what the app's own UI does on request.

### 3. The route

`POST /api/v2/livekit/collection-items` — new, grant-authenticated.

- Body `{ words: string[] }`, the tool's existing input schema (`add-words.ts:48-54`): 1-50 items
  (`MAX_ITEMS`), each 1-500 chars (`MAX_WORD_LENGTH`). Same shared constants, not new numbers.
- Calls **the same data layer as the mobile app's own add**: `addWords(ownerId, words)` then
  `scheduleWordJobs(ownerId)` when anything landed — `apps/web/src/app/api/v2/lesson-items/route.ts:59-67`
  differs from the MCP handler only in passing `ownerId` instead of `ANONYMOUS`. This route is that same
  line with a different way of learning who the owner is.
- Returns `{added, already_present, skipped}` unchanged, so the prompt clause
  (`apps/web/src/agent/prompts/save-to-collection.ts:48-55`) keeps working verbatim.
- Writes `words` only, and attaches nothing to a lesson — **parity with today's tool**, which creates no
  `lesson_items` row either. Changing that is a product decision, not part of this one.

### 4. The worker side

- The tool is declared only when dispatch metadata carries a `grant`
  (`packages/shared/src/tutor/livekit-wire.ts:154-157`, today optional). No grant — `lk agent console`,
  any local run — means the tool is **absent from the `tools` array**, not present and failing at call
  time. The tutor cannot promise what it has no way to do.
- The array stays byte-identical for every turn of a session, which the Phase 1 L2 cache invariant
  requires. It differs *between* a console run and a real lesson; that is fine, it is constant within
  one.
- Every call is written to the `TurnRecord` ledger — the words asked for and what the route answered —
  so the session-end route can reconcile, and so L7 can see the cost of a tool turn.
- **A per-lesson cap on the total words added.** Learner speech is untrusted input to a model holding a
  write tool (§3.10's prompt-injection note). The grant already bounds *whose* collection and *for how
  long*; the cap bounds how much. 200 words per lesson, enforced in the worker and re-checked in the
  route against the ledger, is far above any real lesson.

## What this does not change

- **`/api/mcp`, `MCP_TOKEN`, `auth.ts`, `add-words.ts`: untouched.** `words-1.1`, `2.1` and `3.1` keep
  writing through MCP as `ANONYMOUS`. This design adds a path; it converts nothing.
- **`MCP_TOKEN` still never reaches the worker**, as §10.1 requires.
- The `lesson_sessions` upsert, `sanitizeTranscript` and the LangSmith bridge are the session-end
  route's business and are unaffected — they simply verify the grant with the same helper.

## The consequence worth saying out loud

**The same learner action now produces two different ownerships depending on which tutor said it.** A
word saved in an ElevenLabs lesson is unowned and therefore visible to everyone
(`docs/2026-08-27-mcp-static-token-auth.md` §2: "unowned means everyone's"); the same word saved in a
LiveKit lesson belongs to the learner who said it.

With one learner this is invisible — `ownedOrUnowned()` (`apps/web/src/lib/lesson-items.ts:39-41`) reads
both. With two learners it is the difference between a shared pool and a private collection, and the
LiveKit path is the *correct* one. That document's §11.4 named a second learner as "the one change this
design does not absorb"; this is the first path that absorbs it. If LiveKit ships, the shipped providers
should follow — which needs the token → owner lookup §11.4 describes, and a decision about the unowned
rows already written. **Not this spike's job. Named so it is not a surprise.**

## Open sub-questions, deliberately left

1. **Should a tutor-saved word join the lesson?** Today's tool writes `words` and no `lesson_items` row.
   Kept as-is for parity. Worth asking a learner, not a designer.
2. **Grant renewal for a lesson longer than the TTL.** A 2-hour lesson is not a real case; if pause and
   resume can span it, the resume path re-mints the token anyway and gets a fresh grant with it. Confirm
   this holds when Phase 3 wires resume.
3. **What the tutor says when the route rejects.** A 401 mid-lesson (expired grant, rotated secret)
   should make the tutor say it couldn't save, not invent success. Prompt wording is Phase 3 work.
