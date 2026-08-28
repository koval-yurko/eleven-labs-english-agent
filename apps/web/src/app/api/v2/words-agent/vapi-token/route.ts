import { randomUUID } from "node:crypto";

import { formatItemsList, type TutorItem } from "@tutor/shared/tutor/session";
import type { VapiTokenRequest, VapiTokenResponse } from "@tutor/shared/api";
import { SignJWT } from "jose";

import { resolveVersion } from "../../../../../lib/agent-registry";
import { withBearer } from "../../../../../lib/auth/bearer";
import { vapiConfig } from "../../../../../lib/config";
import { apiError, json, preflight } from "../../../../../lib/http";

// Mints a credential per request; nothing here is cacheable.
export const dynamic = "force-dynamic";

// D25 — without this a browser preflight gets 405 and the real request is never sent.
export const OPTIONS = preflight;

/**
 * How long a minted call credential is good for.
 *
 * Sized against `DEFAULT_MAX_DURATION_SECONDS` (30 min) with room for a slow start and a reconnect,
 * not against "how long is convenient". The token is only ever used once, at `vapi.start()`; a
 * longer life buys nothing and widens the window in which a captured one still works.
 */
const TOKEN_TTL = "1h";

/**
 * `POST /api/v2/words-agent/vapi-token` — the Vapi twin of the ElevenLabs and OpenAI token routes.
 *
 * ## What this route hands out, and why it is not the public key
 *
 * Vapi is the first provider whose client SDK is *designed* to hold a shippable credential: the
 * public API key exists to be embedded. We do not use it. It never expires and it can start any
 * assistant in the org, so a copy lifted from a binary is an open door for as long as the key lives.
 *
 * Instead the private key signs a **public-scope JWT** restricted to this one assistant, with
 * transient assistants forbidden. That last flag is the interesting one: it is what makes "the
 * prompt lives on the server" something VAPI enforces rather than something this codebase merely
 * observes. Without it a client could hand Vapi an entire inline assistant of its own and be
 * teaching a different lesson with our credential.
 *
 * ## Why the assistant id comes from the lockfile
 *
 * Unlike OpenAI — where the session config IS the agent and this route therefore builds the whole
 * thing — a Vapi assistant is a remote object that `pnpm sync:agents` provisions from
 * `src/agent/prompts/`. So the prompt is already there, and the only per-lesson state is the word
 * list. That is the shape `VapiTokenResponse` describes: a credential, the id it is scoped to, and
 * `items_list`.
 *
 * The client passes `itemsList` through untouched into
 * `assistantOverrides.variableValues.items_list`. It never composes that string, so a shipped binary
 * can fail to send the words but cannot change what the lesson teaches.
 *
 * ## The row key is minted here
 *
 * Vapi does mint a call id, but only once the client has connected — after this route has to answer,
 * and somewhere it cannot see. So the conversation id is ours, exactly as it is for OpenAI, and for
 * the same stakes: several writers converge on one `lesson_sessions` row keyed by this column. The
 * adapter still reports Vapi's own id through `onTransportId` once it has one.
 */
export const POST = withBearer(async (req) => {
  const { privateKey, orgId } = vapiConfig();
  if (!privateKey) return apiError(500, "config", "VAPI_PRIVATE_KEY is not set.");
  if (!orgId) return apiError(500, "config", "VAPI_ORG_ID is not set — a public JWT names an org.");

  let body: VapiTokenRequest;
  try {
    body = (await req.json()) as VapiTokenRequest;
  } catch {
    return apiError(400, "bad_request", "Expected a JSON body.");
  }
  if (typeof body?.lessonId !== "string" || body.lessonId.length === 0) {
    return apiError(400, "bad_request", "lessonId is required.");
  }
  const items: TutorItem[] = Array.isArray(body.items) ? body.items : [];

  // One resolver for every provider, so "no version asked for" cannot mean three different things.
  const requested = body.version;
  const resolved = resolveVersion(requested);
  if (!resolved) {
    return apiError(
      requested ? 400 : 500,
      "config",
      requested ? `Unknown or inactive tutor version "${requested}".` : "No active tutor versions.",
    );
  }
  if (resolved.provider !== "vapi") {
    // The same refusal the other two routes make, for the same reason: a version names a prompt
    // written for one pipeline, and running it on another is a different lesson, not a fallback.
    return apiError(
      400,
      "wrong_provider",
      `Tutor version "${resolved.version}" runs on ${resolved.provider}, not Vapi.`,
    );
  }
  // `resolveVersion` returns a nullable id because OpenAI versions have none. A Vapi version always
  // does — it is the provisioned assistant — so an absent one means the lockfile and the registry
  // disagree, which is a deploy problem rather than a request problem.
  if (!resolved.agentId) {
    return apiError(
      500,
      "config",
      `Version "${resolved.version}" has no Vapi assistant in agents.lock.json. Run \`pnpm sync:agents\`.`,
    );
  }

  /**
   * The public-scope JWT, signed with the private key.
   *
   * HS256 with the API key as the shared secret is what Vapi documents and what their own examples
   * produce. The restrictions block is the point of doing this at all:
   *
   *   - `allowedAssistantIds` — this credential can open THIS lesson and nothing else in the org.
   *   - `allowTransientAssistant: false` — it cannot be used to run an inline assistant, which is
   *     what keeps our prompt authoritative.
   *
   * `allowedOrigins` is deliberately omitted. It is a browser concept and a React Native client
   * sends no `Origin` header, so setting it would either do nothing or reject us outright — an
   * untested restriction that can only cost availability. Expiry plus the assistant restriction are
   * what actually bound this token.
   */
  const token = await new SignJWT({
    orgId,
    token: {
      tag: "public",
      restrictions: {
        enabled: true,
        allowedAssistantIds: [resolved.agentId],
        allowTransientAssistant: false,
      },
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(new TextEncoder().encode(privateKey));

  const payload: VapiTokenResponse = {
    token,
    assistantId: resolved.agentId,
    // The value only — the prompt it goes into never leaves this process, because on this provider
    // it never even reaches it: `sync:agents` put it on Vapi.
    itemsList: formatItemsList(items),
    conversationId: randomUUID(),
    version: resolved.version,
  };
  return json(payload);
});
