# Switching between system-prompt versions in the UI

_Date: 2026-06-27 — research note._

**Goal:** be able to keep several versions of the tutor system prompt and pick which one
runs from the UI, to try each of them. (e.g. `words-1.0` vs a new `words-1.1`.)

## TL;DR

- ElevenLabs **does** have native **Agent Versioning**, but it is built for production
  rollout + audit, **not** for explicit "use version X for this one session" selection.
  Native version routing is dashboard-driven or **deterministic traffic-split by
  conversation-id hash** — automatic A/B, not user-pickable.
- For UI-selectable version switching, do it at the **app level**. Two patterns, both fit
  the current signed-URL architecture:
  - **Option A (recommended): one agent per prompt version** + a version→agentId registry.
    The signed-url route picks the agent. Prompt stays fully server-side.
  - **Option B: one agent + per-session prompt override** at `startSession`. Fastest to
    iterate, but the prompt reaches the browser and needs the Security override toggle on.

## What ElevenLabs supports natively (Agent Versioning)

Source: [Agent versioning](https://elevenlabs.io/docs/eleven-agents/operate/versioning),
[Introducing Versioning](https://elevenlabs.io/blog/introducing-versioning).

- Every save creates an **immutable version** (`agtvrsn_xxxx`) capturing the full
  `conversation_config` — **system prompt**, LLM, voice, tools, knowledge base.
- **Branches** (`agtbrch_xxxx`): a `Main` branch (undeletable) plus branches forked from any
  version. Diffs + editor attribution per change.
- **Deployments / traffic split**: `agents.deployments.create()` allocates percentages
  across branches (must total 100). Routing is **deterministic by conversation-id hash** —
  a given conversation consistently lands on the same branch. This is automatic A/B; the
  client cannot say "give me branch B right now."
- **APIs**: `agents.branches.create() / list() / get()`, `agents.deployments.create()`,
  and `agents.get()` accepts `version_id` / `branch_id` to **read** config at a version.
  Versions are created automatically on save (no explicit create-version endpoint).
- **No documented way** to pass a `version_id` to `get-signed-url` or `startSession` to
  force a version for a single session.

**Verdict:** great for audit/compliance and gradual rollout once a winner is chosen, but it
does not give "let me click version X and try it" in our UI. Worth enabling in parallel for
free history once we have >1 prompt in play.

## Current wiring (as of this note)

- `src/agent/agent-prompt.ts` — versioned prompt + `WORDS_TUTOR_PROMPT_VERSION` (`words-1.0`).
- `src/agent/create-agent.ts` — provisions an agent, bakes the prompt in, names it
  `english-words-tutor (${version})`, prints a fresh `agent_id`. **Not idempotent** (new agent
  each run).
- `src/lib/config.ts` — `elevenLabsConfig()` reads a single `ELEVENLABS_STORY_AGENT_ID`.
- `src/app/api/words-agent/signed-url/route.ts` — `GET` mints a signed URL for that one
  agent via `get-signed-url` (the only place the agent is bound; `xi-api-key` stays server).
- `src/app/words/WordsTutor.tsx` — `useConversation().startSession({ signedUrl,
  connectionType: "websocket", dynamicVariables: { items_list } })`. No `overrides` today.

So today, "switch version" = provision a different agent and change one env var.

## Option A — one agent per version (recommended)

Keep the prompt fully server-side; pick the agent at the signed-url route.

1. Provision an agent per prompt version (already what `create-agent.ts` does per run). Save
   each `agent_id` under a per-version env var.
2. Replace the single-id config with a registry:

   ```ts
   // src/lib/config.ts (sketch)
   const AGENTS: Record<string, string | undefined> = {
     "words-1.0": env.ELEVENLABS_AGENT_WORDS_1_0?.trim(),
     "words-1.1": env.ELEVENLABS_AGENT_WORDS_1_1?.trim(),
   };
   export const DEFAULT_VERSION = "words-1.0";
   ```

3. Signed-url route takes a `?version=` param and resolves the agent:

   ```ts
   const version = req.nextUrl.searchParams.get("version") ?? DEFAULT_VERSION;
   const agentId = AGENTS[version];
   if (!agentId) return NextResponse.json({ error: "unknown version" }, { status: 400 });
   ```

4. UI adds a `<select>` of versions; `start()` calls
   `fetch(\`/api/words-agent/signed-url?version=${version}\`)`. No SDK/override changes.

**Pros:** matches existing architecture and the "prompt/secrets stay server-side" convention;
no Security toggles; clean isolation (each version is a real agent, gets native versioning +
its own analytics). **Cons:** N agents to manage; re-provision to add a version.

## Option B — one agent, per-session prompt override

Source: [Overrides](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides).

1. Enable the system-prompt override on the agent (off by default). Security tab → enable
   `conversation_config_override.agent.prompt.prompt`. Via CLI/platform_settings:

   ```json
   { "platform_settings": { "overrides": { "conversation_config_override": {
       "agent": { "prompt": { "prompt": true } } } } } }
   ```

2. Keep each version's prompt string in source (`{ "words-1.0": "...", "words-1.1": "..." }`).
3. Pass the selected one at `startSession` (overrides + dynamic variables combine fine):

   ```ts
   startSession({
     signedUrl,
     connectionType: "websocket",
     overrides: { agent: { prompt: { prompt: SELECTED_PROMPT } } },
     dynamicVariables: { items_list },
   });
   ```

**Pros:** one agent; edit a string and try instantly, no re-provision; ideal for rapid A/B of
many drafts. **Cons:** (1) override must be enabled in Security; (2) the prompt **reaches the
browser** — SDK overrides ride in the client's conversation-init payload. Fine here (the
prompt is not a secret; only API keys are), but it does break "prompt never leaves the
server." Fetching the prompt from our own server at start still ends up in the client.

## Recommendation

Use **Option A** — it fits the current server-bound, source-of-truth-prompt design and needs
no security changes. Reach for **Option B** only when iterating on many prompt drafts fast is
worth putting the prompt text on the client. Turn on **native ElevenLabs versioning** in
parallel for free audit history and as the path to real % traffic splits once a winner is
chosen.

---

# Managing the versions: a filesystem → ElevenLabs sync (chosen for Option A)

**Decision: Option A.** The filesystem is the **source of truth**; a `pnpm sync:agents`
command reconciles ElevenLabs to match it (create / update / retire). Deleting a version file
and re-running sync removes (or retires) the corresponding agent.

## Agent-management API (verified)

| Action | Call | Notes |
| --- | --- | --- |
| Create | `POST /v1/convai/agents/create` | returns `agent_id` (current `create-agent.ts`) |
| Update | `PATCH /v1/convai/agents/:id` | updates `conversation_config` (prompt/llm/tts/voice) **and** `name` in place — same id |
| List | `GET /v1/convai/agents` | returns `agent_id`, `name`, `tags[]`, `archived`, `created_at_unix_secs`; `search`, `cursor`, `has_more` |
| Delete | `DELETE /v1/convai/agents/:id` | permanent |

`archived` exists as an agent field + list filter, but the reliable archive mutation is
branch-level. So "deactivate" = **rename-to-retire + drop from the app registry** (guaranteed
via PATCH `name`); **hard delete** is opt-in. Swap to a true agent-archive call if/when EL
exposes one.

## Source of truth: a prompt-version registry on disk

```text
src/agent/prompts/
  words-1.0.ts      # export default { version, prompt, llm?, voice?, tts? }
  words-1.1.ts
  index.ts          # PROMPT_VERSIONS = [ ...all version modules ]
```

Each version module is self-describing — the prompt text plus the config baked into the agent
(llm, voice, tts model). **Adding a version = add a file. Removing = delete the file.** The
version string is the **identity key** (renaming a version reads as delete+create, so bump
deliberately).

## The bridge: a lockfile

`src/agent/agents.lock.json` maps each version → its ElevenLabs agent id + a content hash:

```jsonc
{
  "version": 1,
  "agents": {
    "words-1.0": { "agentId": "agent_abc", "status": "active",  "hash": "sha256:…", "updatedAt": "2026-06-27T…" },
    "words-0.9": { "agentId": "agent_old", "status": "retired", "hash": "sha256:…", "updatedAt": "2026-06-20T…" }
  }
}
```

- The `hash` covers everything baked into the agent (prompt + llm + voice + tts) so a config-only
  edit still triggers a PATCH.
- **Committed to git** so all environments/deploys share the same agent ids (ids are not
  secrets; only the API key is). The lockfile — not guesswork — is what the runtime and the
  reconcile read.
- `status: "retired"` versions are kept for history/analytics but hidden from the UI.

## The reconcile algorithm (`pnpm sync:agents`)

Desired state = prompt files on disk. Actual state = lockfile (+ optional live `GET /agents`
cross-check by name prefix / tag to catch drift and rebuild a lost lockfile). For each version:

1. **In files, not in lock** → `POST create`, tag/name it `english-words-tutor (words-X.Y)`,
   record `{agentId, hash, active}` in lock.
2. **In files + lock, hash changed** → `PATCH` the agent's `conversation_config` + `name`,
   update `hash`. Same agent id (URLs and analytics survive).
3. **In files + lock, hash equal** → no-op.
4. **In lock (active), not in files** → **prune** per policy:
   - `retire` (default): `PATCH name` → `… [retired]`, set `status:"retired"`, hide from UI.
   - `delete`: `DELETE` the agent, remove from lock.
   - `none`: leave it, just warn.

Then write the lockfile. Flags: `--dry-run` (print the plan, mutate nothing), `--prune=…`.
The script is **idempotent** — re-running with no file changes does nothing. This replaces the
non-idempotent `create-agent.ts` (which made a fresh agent every run).

## Runtime consumption (testing + switching)

- `elevenLabsConfig()` reads `agents.lock.json` → a registry of `active` `{version → agentId}`.
- `GET /api/words-agent/signed-url?version=words-1.1` resolves the agent id from the registry
  and mints the signed URL (unknown/retired version → 400).
- `WordsTutor.tsx` gets a `<select>` of active versions (default = newest); the choice flows
  into the signed-url fetch. No SDK/override changes — still `dynamicVariables.items_list`.
- Each version is a distinct EL agent → independent dashboard analytics + native version
  history per agent.

## Deploy story

1. Edit/add/delete a file under `src/agent/prompts/`.
2. `pnpm sync:agents --dry-run` to review the plan, then `pnpm sync:agents`.
3. Commit the updated `agents.lock.json`. Deploys just read it — no provisioning at deploy time.
4. (Optional) run `pnpm sync:agents --prune=retire` in CI on the default branch to keep EL in
   lockstep with `main`, committing the lockfile back.

## Decisions (2026-06-27)

- **Prune default = `retire`**: a deleted version file renames its agent to `… [retired]` and
  drops it from the UI, keeping the agent + analytics. `--prune=delete` hard-deletes; `--prune=none`
  only warns.
- **Environments = one shared set**: a single `agents.lock.json`, one agent per version, used by
  every environment. Revisit if a separate prod workspace/key appears.
- **Lockfile = committed**: agent ids are not secrets; committing keeps every clone/deploy on the
  same ids and lets the runtime read it directly.

## Implemented (2026-06-27)

- `src/agent/prompts/` — version registry (`types.ts`, `words-1.0.ts`, `words-1.1.ts`, `index.ts`).
- `src/agent/agents.lock.json` — committed version→agent-id map (starts empty).
- `src/agent/sync-agents.ts` — `pnpm sync:agents` / `pnpm sync:agents:plan` reconcile (create /
  update-in-place / retire / delete), idempotent, `--dry-run` / `--prune=` / `--force`.
- `src/lib/agent-registry.ts` — server-only reader exposing active versions + `resolveAgent()`.
- `src/app/api/words-agent/signed-url/route.ts` — accepts `?version=`, mints the URL for that agent.
- `src/app/words/{page.tsx,WordsTutor.tsx}` — version `<select>` (shown when >1 active), gated on
  the registry instead of an env id.
- Removed the old single-agent path (`create-agent.ts`, `agent-prompt*.ts`, `provision:agent`,
  `ELEVENLABS_STORY_AGENT_ID`). First run: `pnpm sync:agents`, then commit the lockfile.

## Sources

- [Agent versioning | ElevenLabs](https://elevenlabs.io/docs/eleven-agents/operate/versioning)
- [Introducing Versioning for ElevenLabs Agents](https://elevenlabs.io/blog/introducing-versioning)
- [Overrides | ElevenLabs](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides)
- [React SDK | ElevenLabs](https://elevenlabs.io/docs/agents-platform/libraries/react)
- [Dynamic variables | ElevenLabs](https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables)
