import { SignJWT, jwtVerify } from "jose";

/**
 * The per-lesson grant: the credential the LiveKit worker writes back with.
 *
 * The worker holds no Supabase key and no `MCP_TOKEN` (research doc §10.1). It authenticates to the
 * two routes that accept its writes — `/api/v2/livekit/session-end` and
 * `/api/v2/livekit/collection-items` — with a token the token route mints for ONE lesson, from the
 * Auth0 `sub` it has just verified through `withBearer`. So a compromised or confused worker can
 * write this learner's lesson and nothing else, and the tutor's `add_words_to_collection` stamps a
 * real owner instead of the `ANONYMOUS` the MCP path is stuck with.
 * See docs/2026-09-25-lesson-grant-tool-authorization.md.
 *
 * **A signed JWT rather than a hand-rolled HMAC.** The research doc says "an HMAC over
 * `{conversationId, ownerId, exp}`", and that is exactly what this is — an HS256 JWT is an HMAC
 * over a payload, with expiry semantics and a constant-time verify already written. The repo has no
 * `createHmac` anywhere in source but already mints this shape with `jose` in
 * `api/v2/words-agent/vapi-token/route.ts`, so this is the pattern a reader here already knows.
 *
 * **It is not an Auth0 token and must never be mistaken for one.** `withBearer` verifies RS256
 * against the tenant's JWKS; this is HS256 against a secret we mint. Neither verifier accepts the
 * other's token — different algorithm, different key, different audience — which is what keeps a
 * grant from being replayed at `/api/v2/lesson-items` to act as the learner in full.
 */

const secret = process.env.LIVEKIT_GRANT_SECRET?.trim();

/**
 * The same 32-character floor `lib/mcp/auth.ts` enforces, for the same reason: a short secret is a
 * typo or a placeholder, and accepting one would make the fail-closed branch below unreachable.
 */
const MIN_SECRET_LENGTH = 32;

const key =
  secret && secret.length >= MIN_SECRET_LENGTH ? new TextEncoder().encode(secret) : null;

if (!key) {
  console.warn(
    "[livekit] LIVEKIT_GRANT_SECRET unset or shorter than 32 chars; every LiveKit write-back will be refused.",
  );
}

/**
 * Long enough for a lesson plus the pauses inside it plus the session-end write that lands after
 * it; short enough that a grant read off a phone's own token (§3.10 — dispatch metadata rides in a
 * signed-not-encrypted JWT claim) stops being useful the same evening.
 */
const GRANT_TTL = "2h";

/** Claims that pin this token to this issuer and this consumer, so it is useless anywhere else. */
const ISSUER = "tutor-web";
const AUDIENCE = "livekit-worker";

export interface LessonGrant {
  /** The `lesson_sessions` row this grant may write, and nothing else. */
  conversationId: string;
  /** The Auth0 `sub` the token route verified. What lands in `words.owner_id`. */
  ownerId: string;
  /**
   * The lesson the session belongs to, checked against this owner when the grant was minted.
   *
   * It is in the grant rather than in the worker's request body because the worker has no way to
   * know it: dispatch metadata carries a lesson's *content*, never its id (research doc §1). Having
   * it signed also means `lesson_sessions.lesson_id` — a NOT NULL foreign key — is filled from
   * something the server authenticated, with no second ownership check at write time.
   */
  lessonId: string;
}

/**
 * Mint the grant. Returns null when the server is not configured for it — the token route refuses
 * the lesson rather than starting one whose write-back can only fail at the end.
 */
export async function signLessonGrant(grant: LessonGrant): Promise<string | null> {
  if (!key) return null;
  return new SignJWT({ cid: grant.conversationId, lid: grant.lessonId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(grant.ownerId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(GRANT_TTL)
    .sign(key);
}

/**
 * Resolve a grant from a request's `Authorization: Bearer` header, or null.
 *
 * Every failure collapses to null for the reason `getBearerOwnerId` gives: the caller has nothing
 * to do with the distinction, and naming the failed check tells an attacker which one to fix.
 *
 * `algorithms: ["HS256"]` is not decoration. Without it a token whose header says `alg: "none"`, or
 * one signed with a public key we publish elsewhere, would be handed to a verifier willing to try.
 */
export async function verifyLessonGrant(req: Request): Promise<LessonGrant | null> {
  if (!key) return null; // misconfigured server fails CLOSED, never open

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  try {
    const { payload } = await jwtVerify(header.slice("Bearer ".length), key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    const conversationId = payload.cid;
    const lessonId = payload.lid;
    const ownerId = payload.sub;
    if (typeof conversationId !== "string" || conversationId.length === 0) return null;
    if (typeof lessonId !== "string" || lessonId.length === 0) return null;
    if (typeof ownerId !== "string" || ownerId.length === 0) return null;
    return { conversationId, ownerId, lessonId };
  } catch {
    return null;
  }
}
