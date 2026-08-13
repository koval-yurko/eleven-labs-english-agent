# S2 — Auth0 on a device, Bearer on the server (B1) · research

**Date:** created 2026-08-13 · enriched, implemented and **run** 2026-08-13 · **Status:** ✅
**PASSED (Half A).** Auth0 login works on-device: a JWT access token, `Bearer` not DPoP, silent
renewal, logout. **Half B — the `/api/v2/me` round-trip — is not run**, because it needs a deployed
server and there is none yet; it is inherited by S3, which cannot run without one either (§7, §10).
B1 is answered: a native client can authenticate against our Auth0 tenant.

**Parents:** [build plan → S2](./2026-08-12-expo-build-plan.md) ·
[creation doc §9 B1](./2026-08-12-expo-app-creation.md) (de-risked in full) and
[§3](./2026-08-12-expo-app-creation.md) (the `/api/v2` design this stage opens) ·
[S1 research](./2026-08-13-expo-s1-background-audio.md) (passed 2026-08-13).

---

## 0. What the enrichment settled

The placeholder asked six questions and warned that the token-refresh story depended on S1's verdict.
**S1 passed on plain background audio with no CallKit**, so the session lifecycle is ordinary and that
dependency dissolved. Two findings below are the kind that cost a day if met on the device instead.

| Placeholder question                                    | Answer                                                                                                                                                                 | Where  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| CallKit branch, changing token refresh?                 | **No** — S1 passed at rung zero. Refresh is a normal foreground/background concern.                                                                                    | §1     |
| Which JWKS library, and the exact assertions?           | **`jose`**, already in the tree at 6.2.3 but **transitively only** — it must become a direct dependency.                                                               | §2 D15 |
| Where does the token live on device?                    | `react-native-auth0`'s credentials manager (iOS Keychain), via `getCredentials()`.                                                                                     | §5     |
| Silent renewal, and its failure mode?                   | `getCredentials()` renews transparently given `offline_access`. **The gate cannot be tested without lowering the API token lifetime first** — the default is 24 hours. | §2 D17 |
| Logout at S2 or S7?                                     | **S2**, minimally — it is the only way to re-run the login gate.                                                                                                       | §2 D18 |
| How does every v2 route share the auth check?           | A `withBearer` wrapper, not a per-route call.                                                                                                                          | §2 D16 |
| How is `/api/v2/me` exercised from a device?            | **Not over `http://` on a LAN IP** — App Transport Security blocks cleartext in a Release build. §6.                                                                   | §6     |
| Does the proxy need changing to let Bearer requests in? | **No** — verified: it already passes `/api/*` through unauthenticated so routes can answer 401 themselves.                                                             | §4.1   |

**Already researched, do not re-derive:** creation doc §9 B1 established that every query runs through
the service-role client with explicit `owner_id` filtering, so **nothing in the data path reads the
access token**. Switching mobile to a JWT changes the login authorization parameters and nothing else.
That is why this was downgraded from the largest risk to the smallest.

---

## 1. Inputs from S1 — filled in

From [S1 §12](./2026-08-13-expo-s1-background-audio.md#12-what-s1-hands-to-s2).

- **S1 passed at rung zero** — plain background audio, no CallKit. A session survives a locked screen
  in both directions, so a lesson can outlive an access token while backgrounded and **silent renewal
  is genuinely load-bearing**, not theoretical.
- **The env mechanism is not what the S2 placeholder assumed.** There is no `env.config.ts` — Expo's
  config loader cannot import a relative TS value module. The per-variant map lives in
  `app.config.ts`'s `VARIANTS`, typed by `apps/mobile/env.types.ts`, read via `extra.env` by
  `apps/mobile/src/env.ts`. **Read [S1 §4.2](./2026-08-13-expo-s1-background-audio.md) before adding
  fields**, and note `satisfies Record<Variant, VariantConfig>` will force all three variants to
  supply every field you add.
- **Current plugin list** in `app.config.ts`: `expo-router`, `expo-splash-screen`,
  `@livekit/react-native-expo-plugin`, `@config-plugins/react-native-webrtc`. `react-native-auth0`
  joins it here.
- **`pnpm native` (prebuild + pods) works. `pnpm device:release` has never been run** — S2 is the
  first stage that wants a local loop, so it will find out.
- **The dev client is still unbuilt**, and `expo-dev-launcher` is `debugOnly`, so it is absent from
  Release builds entirely.
- **Three bundle ids / schemes** (S0/D7): `work.kovalchuk.yurii.english-tutor{,-preview,-dev}` with
  `englishtutor` / `englishtutorpreview` / `englishtutordev`.

---

## 2. Decisions — settled 2026-08-13

### D14 — the Auth0 callback scheme: use the plugin's `{bundleId}.auth0` default ✅

**This reverses an assumption carried since S0/D7**, which said the Auth0 `customScheme` must be
`variant.scheme`. That was written before anyone read the plugin. Reading
`react-native-auth0@5.11.0`'s `withAuth0.ts` changes the answer:

```ts
let bundleIdentifier = config.ios.bundleIdentifier + ".auth0"; // APPLICATION_ID_SUFFIX
if (customSchemes.length === 0) customSchemes = [bundleIdentifier];
```

With **no** `customScheme`, the plugin registers `{bundleIdentifier}.auth0` as the callback scheme.
That is better than passing `variant.scheme`, for three reasons:

1. **It is already per-variant unique**, because the bundle identifier is. D7's actual worry — two
   installed apps claiming one scheme and iOS picking undefined — is satisfied without threading
   anything through.
2. **It keeps auth callbacks separate from the app's own deep links.** `app.config.ts` already sets
   top-level `scheme: variant.scheme` for `expo-router`. Passing the same string to the Auth0 plugin
   makes one scheme mean two things, and a future universal-link or share-sheet feature then has to
   share a namespace with the OAuth callback for no benefit.
3. **It is the pattern Auth0's own iOS quickstart uses**, so the dashboard values match the docs.

**Therefore the plugin entry carries `domain` only:**

```ts
["react-native-auth0", { domain: variant.env.auth0Domain }],
```

and the three callback/logout URLs to register are — **verified against the SDK's own URL builder**,
`NativeWebAuthProvider.getCallbackUri`: `` `${scheme}://${domain}/${Platform.OS}/${bundleId}/callback` ``,
with `getDefaultScheme` returning `` `${bundleId.toLowerCase()}.auth0` ``:

```text
work.kovalchuk.yurii.english-tutor.auth0://<AUTH0_DOMAIN>/ios/work.kovalchuk.yurii.english-tutor/callback
work.kovalchuk.yurii.english-tutor-preview.auth0://<AUTH0_DOMAIN>/ios/work.kovalchuk.yurii.english-tutor-preview/callback
work.kovalchuk.yurii.english-tutor-dev.auth0://<AUTH0_DOMAIN>/ios/work.kovalchuk.yurii.english-tutor-dev/callback
```

⚠️ **The runtime lowercases the bundle id; the config plugin does not.** `getDefaultScheme` and
`getCallbackUri` both call `.toLowerCase()`, while `withAuth0.ts` writes
`config.ios.bundleIdentifier + '.auth0'` into `CFBundleURLTypes` verbatim. A bundle id containing an
uppercase letter would therefore register one scheme and request another — login opens and never
returns, with nothing in the logs to say why. **Ours are all lowercase**, so this is safe rather than
lucky; it is recorded because it silently constrains any future bundle identifier.

**Verify in the generated `Info.plist`, do not assume.** Expo's core `scheme` handling also writes
`CFBundleURLTypes`, and the plugin only skips a scheme it can already see in that array — so ordering
between the two mods decides whether anything is duplicated. `npx expo prebuild` then read
`CFBundleURLTypes`: expect one entry for `variant.scheme` and one named `auth0` for the `.auth0`
scheme.

**The plugin also patches the AppDelegate** (`withAppDelegate`), so it is a prebuild-time change.
Nothing about it works in Expo Go, which is moot — we have not used Expo Go since S1.

### D15 — `jose`, and it becomes a direct dependency ✅

`jose@6.2.3` is already resolvable inside `apps/web`, but only transitively:

```text
jose 6.2.3
├─┬ @auth0/nextjs-auth0@4.23.0 → web
├─┬ livekit-client@2.16.1 → @elevenlabs/client → @elevenlabs/react → web
└─┬ openid-client@6.8.4 → @auth0/nextjs-auth0
```

**Add it to `apps/web/package.json` explicitly.** Verifying access tokens is not something to do with
a package that is present by accident: an Auth0 SDK upgrade that drops or majors `jose` would break
authentication for the mobile app, and the failure would look like "tokens stopped working" rather
than "a dependency moved". This is the same reasoning as S1/D10's pinning, in a lower-stakes place.

`jose` is ESM-only (`"type": "module"`) with a `./jwks/remote` subpath; Next 16's server runtime
handles that natively.

### D16 — one `withBearer` wrapper, not a per-route check ✅

Every `/api/v2/*` route needs the same three lines. Written per-route, the failure mode is a route
that forgets them and serves another learner's rows — and it fails **open**, silently, on a route that
otherwise looks finished.

```ts
// apps/web/src/lib/auth/bearer.ts
export function withBearer<T>(
  handler: (req: Request, ownerId: string) => Promise<Response>,
): (req: Request) => Promise<Response>;
```

A handler cannot be written without receiving `ownerId`, so "forgot the auth check" stops being
expressible. `getOwnerId()` is untouched and stays cookie-only — the v2 namespace exists precisely so
there is no shared branch to regress (creation doc §3.1).

### D17 — lower the API token lifetime to test renewal, then restore it ✅

**The gate's renewal criterion is untestable as written.** Auth0's default access token lifetime for a
custom API is **86,400 seconds — 24 hours** (max 2,592,000). "Background the app past the token
lifetime" therefore means waiting a day.

So the procedure is: set **Maximum Access Token Lifetime = 300** (5 minutes) on the API while testing,
exercise renewal, then **restore it to 86400** and note the restore in the handoff. A forgotten 300 s
lifetime is a slow leak — it works, it just refreshes constantly — so this is written down as a step
rather than left to memory.

**Dashboard path:** Applications → APIs → _English Tutor API_ → Settings → _Access Token Expiration_.

### D18 — a minimal logout ships at S2, not S7 ✅

The placeholder asked whether logout belongs to S7. It belongs here, for a testing reason rather than
a product one: **without it the login gate can be run exactly once per install.** Re-testing means
deleting and reinstalling the app, which on ad-hoc distribution is a rebuild-and-reinstall cycle.
`clearCredentials()` plus `clearSession()` is a few lines, and S7 can style whatever it wants around
it later.

---

## 3. The Auth0 dashboard — record the real values here

Do these as research, before writing code, and **write the actual values into this section** so S3 and
S7 never guess.

**1. APIs → Create API**

| Field                | Value                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Name                 | `English Tutor API`                                                                                                        |
| Identifier           | **`<AUTH0_API_AUDIENCE>`** — created 2026-08-13. URI form, **immutable**, and deliberately not a real endpoint (see §3.1). |
| Signing algorithm    | **RS256** — asymmetric, so the server verifies via public JWKS and no secret is distributed                                |
| Permissions / scopes | **none** — authorization is `sub`-based ownership; RBAC would be a second, redundant model                                 |

**2. Applications → Create Application → Native.** A **second** application beside the existing
Regular Web App. Native is a public client using PKCE and cannot reuse the web client's id.

- _Allowed Callback URLs_ **and** _Allowed Logout URLs_: the three `.auth0` URLs from D14,
  comma-separated, in this one application.

**3. Nothing else.** The `post-login` Action adding `role: "authenticated"` and the Supabase
Third-Party Auth registration (`supabase/README.md` steps 2–3) are **only** needed to activate
Postgres RLS, which this port is not doing.

### 3.2 D20 — no identifier is committed; values come from the environment

Decided by the owner on 2026-08-13, reversing
[S1 §4.2](./2026-08-13-expo-s1-background-audio.md)'s committed-values design. The Auth0 client id,
the API identifier, the tenant domain and the agent id are treated as things that should not sit in
git, so:

| Context                                       | Source of values                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| local `expo start` / `expo run:ios`           | `apps/mobile/.env` (gitignored)                                         |
| local build (`pnpm native`, `device:release`) | the same `.env`                                                         |
| EAS cloud build                               | EAS environment variables, chosen by each profile's `environment` field |

**What survives from the old design is the part that mattered.** `MobileEnv` still declares the field
list; `ENV_VARS` in `app.config.ts` maps each field to a variable name and is written
`satisfies Record<keyof MobileEnv, string>`, so **adding a field is a compile error until it is given
a variable name**. `src/env.ts` is still the only reader and still throws rather than defaults. Only
the _source_ of the values moved: "which values does this app depend on?" is still answerable from a
checkout via `env.types.ts` and `.env.example`; "what are they?" is now answered by the environment,
deliberately.

**A missing variable warns at config time and throws at use time**, rather than failing the build.
Blocking would make an unrelated stage untestable — `apiBaseUrl` is legitimately empty until the
server is deployed, and Half A of the gate does not need it. Verified: with no `.env`, `expo config`
prints `[app.config] APP_VARIANT=preview: not set — EXPO_PUBLIC_AGENT_ID, …`.

**One correction worth stating plainly, because it changes what this protects.** These values are not
confidential once shipped: everything in `extra` is embedded in the app manifest and readable from any
`.ipa`, and an Auth0 Native client id is a **public** client by design (PKCE, no secret) — Auth0
issues it without a secret precisely because it cannot keep one. Keeping them out of git is reasonable
hygiene against casual disclosure; it is not a security boundary. The real boundary is that no genuine
secret ever reaches the client, which is what the token route exists for (creation doc §3.5).

**The committed docs were scrubbed to match**, replacing concrete identifiers with `<AUTH0_DOMAIN>`,
`<EXPO_PUBLIC_AUTH0_CLIENT_ID>`, `<AUTH0_API_AUDIENCE>` and `<EXPO_PUBLIC_AGENT_ID>`. They still say
_which_ value is needed and _where_ it lives, which is what a later stage actually needs.
⚠️ **`apps/web/src/agent/agents.lock.json` still commits the four tutor agent ids** — it is generated
by `pnpm sync:agents`, and the point of the lockfile is that every environment shares the same ids, so
changing that is a larger decision and is left alone.

### 3.3 Inventory

Recorded 2026-08-13, so "is everything defined?" is answerable from one table instead of four files.

| Value                                                   | Lives in                                      | State                                                                                        |
| ------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Auth0 API (identifier)                                  | Auth0 dashboard                               | ✅ `<AUTH0_API_AUDIENCE>`, RS256, no scopes                                                  |
| Native application                                      | Auth0 dashboard                               | ✅ client id `<EXPO_PUBLIC_AUTH0_CLIENT_ID>`                                                 |
| 3 callback + 3 logout URLs                              | Auth0 Native app                              | ✅ registered (D14 form)                                                                     |
| `AUTH0_DOMAIN`                                          | `apps/web/.env`                               | ✅ `<AUTH0_DOMAIN>` — pre-existing, reused for JWKS + `iss`                                  |
| `AUTH0_API_AUDIENCE`                                    | `apps/web/.env` + `.env.example`              | ✅ added — verification only                                                                 |
| `AUTH0_AUDIENCE`                                        | `apps/web/.env`                               | ✅ **absent, and must stay absent** — `.env.example` now carries a LEAVE EMPTY warning       |
| `EXPO_PUBLIC_AUTH0_DOMAIN` / `_CLIENT_ID` / `_AUDIENCE` | `apps/mobile/.env` local · EAS env vars cloud | ✅ set locally **and on EAS** (all three environments)                                       |
| `EXPO_PUBLIC_AGENT_ID`                                  | same                                          | ✅ set locally **and on EAS** — development + preview only, absent from production by design |
| `EXPO_PUBLIC_API_BASE_URL`                              | same                                          | ⛔ **empty — blocked on deployment** (§6)                                                    |
| `environment` per build profile                         | `apps/mobile/eas.json`                        | ✅ added — development / preview / production                                                |
| Access-token lifetime 300                               | Auth0 API settings                            | ⛔ **not yet done** — needed only for the renewal gate (D17)                                 |
| `AUTH0_API_AUDIENCE` on the host                        | deployment env                                | ⛔ pending the deployment                                                                    |
| `APP_BASE_URL` on the host                              | deployment env                                | ⛔ pending the deployment                                                                    |

**The EAS side is done — uploaded 2026-08-13** with `--visibility plaintext --scope project`, and
verified end to end with `eas config --profile preview`, which reports both mechanisms engaging:

```text
Environment variables with visibility "Plain text" and "Sensitive" loaded from the "preview"
environment on EAS: EXPO_PUBLIC_AGENT_ID, EXPO_PUBLIC_AUTH0_AUDIENCE,
EXPO_PUBLIC_AUTH0_CLIENT_ID, EXPO_PUBLIC_AUTH0_DOMAIN.
Environment variables loaded from the "preview" build profile "env" configuration: APP_VARIANT.
```

…and resolves `extra.env` fully populated, with `apiBaseUrl: ""` as expected. That output is worth
knowing: `environment` and `env` are **different mechanisms that both fire** — the first pulls the
EAS-hosted set, the second supplies `APP_VARIANT` from `eas.json`. Losing either breaks a build in a
different way, and only one of them is visible in the repo.

**`EXPO_PUBLIC_AGENT_ID` was set on development and preview only.** Production carries the three
Auth0 values and no agent id, so a production build that somehow reached the S1 probe screen throws
rather than connecting to a publicly-reachable agent.

The commands, for the record:

```bash
for e in development preview production; do
  eas env:set --name EXPO_PUBLIC_AUTH0_DOMAIN    --value <domain>    --environment $e --visibility plaintext
  eas env:set --name EXPO_PUBLIC_AUTH0_CLIENT_ID --value <client-id> --environment $e --visibility plaintext
  eas env:set --name EXPO_PUBLIC_AUTH0_AUDIENCE  --value <audience>  --environment $e --visibility plaintext
done
# EXPO_PUBLIC_AGENT_ID: development + preview only — no publicly-connectable agent ships to production
```

`plaintext` is the right visibility: the values are inlined into the app anyway, so `secret` would
only make them harder to debug without making them any less readable from the binary.

**One Auth0 Native application serves all three variants.** They differ only by callback URL, which
the SDK derives from the bundle identifier — so `auth0ClientId` is identical across variants by
design, not by oversight. That is why it is spread from a single `AUTH0` constant rather than
repeated three times.

**`EXPO_PUBLIC_API_BASE_URL` is empty and that is the correct state**, not a placeholder to be filled
with something plausible. `required()` throws naming the variable, so a build that reaches an API call
before the deployment exists fails loudly instead of hanging on a dead host.

### 3.1 Neither URL is reachable, and neither is supposed to be

Both values look like web addresses and neither is one. This trips people into "registering" a domain
or debugging DNS, so it is written down once.

**The API identifier is an opaque string.** Auth0's own documentation is explicit: _"Auth0 will not
call your API at all"_, and the value _"doesn't have to be a publicly available URL"_. It exists only
to be compared: the app asks for it via `authorize({ audience })`, Auth0 stamps it into the token's
`aud` claim, and `jwtVerify(..., { audience })` checks that the two strings match. URI form is a
convention that keeps identifiers globally unique, nothing more. Nothing resolves it, ever.

**The callback URL is a custom URL scheme, not HTTP.** The part before `://` —
`work.kovalchuk.yurii.english-tutor.auth0` — is the scheme, and the app claims it in
`CFBundleURLTypes` at build time. Everything after it, including `<AUTH0_DOMAIN>`, is
just path _inside_ that scheme: Auth0's namespacing convention so one app can host callbacks for
several tenants. **iOS routes it by scheme, never by DNS.** That is exactly why none of it needs to be
owned or hosted, and why no `apple-app-site-association` file or domain verification is involved —
that machinery belongs to Universal Links (`https://` callbacks), which we are deliberately not using.

**Two consequences worth stating:**

- **Both are exact-match.** The identifier is compared as a string, so
  `<AUTH0_API_AUDIENCE>` and the same value with a trailing slash are different
  audiences. Whatever Auth0 holds must be byte-identical in `AUTH0_API_AUDIENCE` and in the app's
  `authorize({ audience })`. The same rule governs the scheme, which is why D14's lowercase note
  matters.
- **Nothing here is testable before the app exists.** There is no URL to `curl` and no endpoint to
  ping. The first real verification of either value is the S2 gate itself: login returning to the app
  proves the scheme, and `GET /api/v2/me` returning a `sub` proves the audience. The one check
  available earlier is post-prebuild — confirm the scheme actually landed in `CFBundleURLTypes`.

**Known already, read from `apps/web/.env` on 2026-08-13:**

| Value                | Current state                                                                         |
| -------------------- | ------------------------------------------------------------------------------------- |
| Tenant domain        | **`<AUTH0_DOMAIN>`** → `iss` is `https://<AUTH0_DOMAIN>/` (**trailing slash**)        |
| Existing web app     | Regular Web App — `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` set. **Do not touch it.** |
| `AUTH0_AUDIENCE`     | **not present** ✅ — exactly right, and it must stay that way (see the box in §4.2)   |
| `AUTH0_API_AUDIENCE` | not present — added by this stage, server-side only                                   |
| `APP_BASE_URL`       | `http://localhost:3000` — unrelated to the native flow, left alone                    |

**Record when done:**

- [x] API identifier: **`<AUTH0_API_AUDIENCE>`** (created 2026-08-13)
- [ ] Native application client id: `________`
- [ ] `AUTH0_API_AUDIENCE` added to `apps/web/.env` **and** to the deployment's env
- [ ] Token lifetime restored to 86400 after testing (D17)

---

## 4. The server

### 4.1 The proxy needs no change — verified

`apps/web/src/proxy.ts` already does the right thing:

```ts
const session = await auth0.getSession(request);
if (!session) {
  if (pathname.startsWith("/api/")) return authRes;   // ← API routes self-report 401
  return NextResponse.redirect(new URL("/auth/login", …));
}
```

A Bearer request carries no Auth0 cookie, so `getSession` returns null, and the `/api/` branch passes
it straight through to the handler. **This was worth checking rather than assuming**: had the proxy
redirected unauthenticated API calls, every v2 request would have received an HTML login page and the
failure would have looked like a broken route.

### 4.2 `apps/web/src/lib/auth/bearer.ts`

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import { apiError } from "../http";

const domain = process.env.AUTH0_DOMAIN?.trim();
// VERIFICATION ONLY. Deliberately NOT `AUTH0_AUDIENCE` — see the box below.
const audience = process.env.AUTH0_API_AUDIENCE?.trim();

// Module scope on purpose: createRemoteJWKSet caches keys and handles rotation and cooldown
// itself. Building it per request would fetch JWKS on every call and defeat both.
const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));

export async function getBearerOwnerId(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jwtVerify(header.slice(7), jwks, {
      issuer: `https://${domain}/`, // TRAILING SLASH — Auth0's iss has one; without it every token fails
      audience,
      algorithms: ["RS256"], // pin it: never let the token choose its own algorithm
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null; // expired, wrong audience, bad signature, malformed — all the same to a caller
  }
}
```

> **Do not set `AUTH0_AUDIENCE`.** `apps/web/src/lib/auth0.ts` reads it and, when set, adds
> `authorizationParameters: { audience, scope: "…offline_access" }` to the **web** client — changing
> the web login flow, which D4 forbids. The server never needs to _request_ an audience in order to
> _verify_ one. `supabase/README.md` step 4 says to set `AUTH0_AUDIENCE`; that instruction belongs to
> the RLS activation path, which this port is not doing.

**Why `algorithms: ["RS256"]` is not decoration.** Without pinning, a verifier can be steered by the
token's own `alg` header — the classic JWT confusion attack. It costs one line.

### 4.3 `GET /api/v2/me`

```ts
export const GET = withBearer(async (_req, ownerId) => json({ sub: ownerId } satisfies MeResponse));
```

It exists to make this gate unambiguous, and stays useful afterwards as an auth/liveness probe.
Declare `MeResponse` and `API_V2` in `packages/shared/src/api.ts` per creation doc §3.4 — this is the
first v2 route, so it sets the shape every later one follows.

**Return 401 through the existing envelope.** `apiError`/`unauthorized` in `apps/web/src/lib/http.ts`
already build `ApiErrorBody`, and the app narrows with `isApiError`. No new error shape.

---

## 5. The app

```bash
npx expo install react-native-auth0     # 5.11.0 — peers react >=19, react-native >=0.78 ✓
```

**No New-Architecture concern here.** React Native Directory reports `react-native-auth0` as
`newArchitecture: true` **with no caveat note** — unlike the LiveKit packages, which are supported
only "through the compatibility layer for legacy native modules" (S1/D13). Nothing in its dependency
set (`@auth0/auth0-spa-js`, `jwt-decode`, `base-64`, `url`) touches the pinned LiveKit/ElevenLabs
graph, so S1's carefully balanced resolution is not at risk. **Re-check `pnpm why livekit-client`
after installing anyway** — one copy at 2.16.1 — because that invariant is cheap to check and
expensive to lose.

#### No client secret is involved anywhere in this stage

A reasonable question, since `apps/web/.env` already has an `AUTH0_CLIENT_SECRET`. There are three
distinct credentials in play and only one of them is a secret:

| Client                                    | Credentials            | Where                                         |
| ----------------------------------------- | ---------------------- | --------------------------------------------- |
| Web app (Regular Web App, _confidential_) | client id **+ secret** | `apps/web/.env` — pre-existing, **untouched** |
| Mobile app (Native, _public_)             | client id only         | `EXPO_PUBLIC_AUTH0_CLIENT_ID`                 |
| Our server, verifying tokens              | **none**               | the tenant's public JWKS over HTTPS           |

**The Native app has no secret because it cannot keep one.** A public client ships to devices, and
anything embedded in the binary is extractable from the `.ipa`; PKCE exists precisely to replace the
secret with a per-authorization proof. This is not a shortcut — `react-native-auth0` offers nowhere
to put one: `Auth0Options` is `{ domain, clientId, timeout, headers, useDPoP, maxRetries,
credentialsManagerStorageKey, localAuthenticationOptions }`, and the string `client_secret` does not
appear anywhere in the built package.

**The server needs no secret either**, which is why §3 chose **RS256**. Asymmetric signing means the
tenant signs with its private key and we verify against the public JWKS, so no shared secret is ever
distributed. Had we chosen HS256, the signing secret would have had to live on both sides and
`getBearerOwnerId` would be holding one.

**There is nothing to configure for this, and no dashboard field to hunt for.** Registering an
application as **Native** automatically flags it as a public client: Auth0 sets
`token_endpoint_auth_method` to `none` on creation and does not render the setting in the dashboard
for Native or SPA apps. It can only be changed through the Management API — which is precisely what
you would not want to do here. (An earlier draft of this file said to verify the field. That was
wrong, and it sends the reader searching Advanced Settings for something that is not displayed.)

⚠️ **What is worth checking instead, because it is visible and does matter:** Applications → the
Native app → Settings → Advanced Settings → **Grant Types** must include **Refresh Token**. Native
apps get it by default alongside Authorization Code, but it is the grant that lets `offline_access`
actually issue a refresh token — without it `getCredentials()` cannot renew silently and §7's
renewal criterion fails. That symptom reads as "login works, then the app logs itself out later",
which is far more confusing to chase than a missing checkbox.

**`MobileEnv` gains four fields** (S1 §4.2), and all three variants must then supply them:

```ts
export type MobileEnv = {
  agentId: string; // S1; deleted at S3
  auth0Domain: string;
  auth0ClientId: string;
  auth0Audience: string; // the API identifier from §3
  apiBaseUrl: string; // see §6 — this is where the ATS trap lives
};
```

**Login:**

```ts
const { authorize, getCredentials, clearCredentials } = useAuth0();

await authorize({
  audience: env.auth0Audience, // "<AUTH0_API_AUDIENCE>" — exact string match
  scope: "openid profile email offline_access", // offline_access ⇒ refresh token ⇒ silent renewal
});
```

**`offline_access` is the difference between shippable and not.** Without it there is no refresh
token, `getCredentials()` cannot renew, and the learner re-authenticates when the access token
expires — mid-lesson, on a phone, during a spoken conversation.

**Credentials live in the iOS Keychain**, managed by the SDK. `getCredentials()` returns the cached
access token and renews it transparently when expired. Two behaviours to confirm on device rather
than trust: survival across app kill, and across device restart.

---

## 6. Testing from a device — the ATS trap

The placeholder asked how `/api/v2/me` is exercised against a **local** dev server. The obvious answer
is the wrong one.

**`http://192.168.x.x:3000` will not work from a Release build.** iOS App Transport Security blocks
cleartext HTTP by default, and S1 established that `preview` (Release) builds are what we install.
Two ways out, and the second is preferred:

| Option                                                                                                                     | Cost                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NSAppTransportSecurity.NSAllowsLocalNetworking` in `infoPlist`                                                            | Works, but it is an ATS exception in the app. **Gate it to the `development` variant only** — it must never reach a store build.                                                                                                        |
| **An HTTPS tunnel** (`cloudflared` / `ngrok`) pointed at `pnpm dev`, its URL in `apiBaseUrl` for the `development` variant | No ATS exception at all, and it exercises real TLS. **Recommended.** The URL changes per session, and changing `apiBaseUrl` needs a rebuild — which is the argument for doing S2's iteration on a **dev client** rather than `preview`. |

`apiBaseUrl` per variant is therefore: a tunnel URL for `development`, the deployed origin for
`preview` and `production`.

**This is the stage that finally needs the dev client** (unbuilt since S0). Unlike S1 — where a dev
client would have invalidated the measurement — S2 has no timing-sensitive measurement, and the login
round-trip benefits enormously from a fast reload loop. Build the `development` profile here.

---

## 7. Gate (fixed now) — runnable in two halves

**There is no tunnel and no deployment yet** (decided 2026-08-13), so the gate splits along the line
of what needs our server. The first half needs only Auth0 and the phone, and can be run immediately;
the second waits on the deploy. Both halves must pass before S3.

**Half A — the device, no server required:**

- [ ] After `npx expo prebuild`, the callback scheme is present in the generated `Info.plist`'s
      `CFBundleURLTypes` — the only check available before anything runs (§3.1)
- [ ] Auth0 login completes **on-device**, and the callback returns to the app
- [ ] `getCredentials()` returns an access token that is a **JWT** (three dot-separated segments),
      not an opaque string
      **Half B — after the server is deployed and `apiBaseUrl` is filled in:**

- [ ] `GET /api/v2/me` with that Bearer returns the **same `sub`** the web app shows for that account
- [ ] `GET /api/v2/me` with **no** token, and with a **garbage** token, both return **401** in the
      `ApiErrorBody` envelope — the failure direction, checked explicitly
- [ ] With the API token lifetime temporarily at 300 s (D17), background the app past expiry and
      confirm `offline_access` renews **silently** — no login prompt
- [ ] **Web login verified unchanged**: sign out and back in on the web app after the server change
- [ ] Token lifetime restored to 86400 (D17)

**The renewal check is not optional. A phone that re-prompts for login mid-lesson is not shippable.**

The negative check (401 on a bad token) is listed because `getBearerOwnerId` returns `null` for every
failure mode. A wrapper that mistakenly treated `null` as "anonymous but allowed" would pass every
other line of this gate.

---

## 8. If it fails

| Symptom                                         | Cause                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `service not found` on login                    | The API does not exist yet, or `audience` does not match its identifier exactly. Create the API first.              |
| Token is opaque, not a JWT                      | No audience was requested. Auth0 issues a JWT only when a custom API audience is asked for.                         |
| Login opens, never returns to the app           | Callback URL mismatch. Compare the registered URL against the **actual** `CFBundleURLTypes` in the built app (D14). |
| Every request 401s with a token that looks fine | The `iss` trailing slash, or `aud` pointing at the tenant rather than the API identifier.                           |
| Web login broke                                 | You set `AUTH0_AUDIENCE`. Unset it; use `AUTH0_API_AUDIENCE` for verification only.                                 |
| Renewal re-prompts for login                    | `offline_access` missing from the requested scope, or refresh token rotation revoked the token.                     |
| Cleartext HTTP request fails only in `preview`  | ATS. §6 — use a tunnel, not a LAN IP.                                                                               |

---

## 9. Implementation — built 2026-08-13

### What was built

| File                                  | What it is                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/shared/src/api.ts`          | `API_V2`, `API_V2_ROUTES`, `MeResponse`, `isMeResponse` — the first v2 contract          |
| `apps/web/src/lib/auth/bearer.ts`     | `getBearerOwnerId` + the `withBearer` wrapper (D16)                                      |
| `apps/web/src/app/api/v2/me/route.ts` | `GET /api/v2/me`, four lines, body assigned to `MeResponse`                              |
| `apps/web/.env` + `.env.example`      | `AUTH0_API_AUDIENCE`, plus a LEAVE EMPTY warning on `AUTH0_AUDIENCE`                     |
| `apps/mobile/env.types.ts`            | four new `MobileEnv` fields                                                              |
| `apps/mobile/app.config.ts`           | the `AUTH0` constant spread into all three variants, and the `react-native-auth0` plugin |
| `apps/mobile/src/env.ts`              | getters for the four                                                                     |
| `apps/mobile/src/app/_layout.tsx`     | `Auth0Provider` with **`useDPoP={false}`** (D19)                                         |
| `apps/mobile/src/app/auth.tsx`        | the S2 screen — login / renew / logout, `GET /me`, and the 401 checks                    |
| `pnpm-workspace.yaml`                 | `browser-tabs-lock: false`                                                               |

### D19 — `useDPoP: false`, and it had to be explicit

**`react-native-auth0` v5 enables DPoP by default** (`Auth0Options.useDPoP`, `@default true`).
DPoP (RFC 9449) binds tokens to a client key pair and changes the wire format: the header becomes
`Authorization: DPoP <token>` plus a signed `DPoP` proof per request, and `Credentials.tokenType`
becomes `"DPoP"` rather than `"Bearer"`.

Our server verifies a plain Bearer JWT, so inheriting that default would have produced **401s against
a token that decodes perfectly** — the worst kind of failure to debug, because everything you can
inspect by eye looks right. Supporting DPoP properly means server-side proof validation (`htm`/`htu`/
`ath` claims, nonce handling, `jkt` binding), which is a real project and not S2's scope. Set
explicitly to `false`, with the reasoning in the code, and the probe screen **warns if `tokenType`
ever comes back as anything but `Bearer`** so a future SDK change cannot reintroduce this quietly.

### What the checks proved

| Check                                             | Result                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expo prebuild` → `CFBundleURLTypes`              | **D14 confirmed.** A distinct entry `CFBundleURLName: "auth0"` with scheme `work.kovalchuk.yurii.english-tutor-preview.auth0` — matching the registered callback URL, and **no duplicate**: Expo's own `englishtutorpreview` / bundle-id schemes sit in a separate entry. |
| `Podfile.lock`                                    | `Auth0 2.24.1`, `JWTDecode 3.3.0`, `SimpleKeychain 1.3.0` linked                                                                                                                                                                                                          |
| `pnpm why livekit-client`                         | still exactly one copy at **2.16.1** — S1's resolution survived the new dependency                                                                                                                                                                                        |
| `pnpm peers check`                                | only the known `expo: ^56` warning; `react-native-auth0` added none                                                                                                                                                                                                       |
| `expo-doctor`                                     | 20/20                                                                                                                                                                                                                                                                     |
| typecheck / lint / `check:shared` / `expo export` | all green across the workspace                                                                                                                                                                                                                                            |

**One install snag worth recording.** `react-native-auth0` pulls `@auth0/auth0-spa-js`, which pulls
`browser-tabs-lock`, whose `postinstall` pnpm 10+ blocks. Reading the script shows it is a
`console.log` advertisement and nothing else, and it arrives via the **web** platform adapter that an
iOS-only app never executes — so it is denied in `pnpm-workspace.yaml` rather than approved. It had to
be answered either way: an unanswered package makes `pnpm install` exit non-zero.

The generated `ios/` was deleted afterwards, for the same reason as S1 §9 — it was prebuilt for
`preview` while `.env` says `development`, and that mismatch on disk is a trap.

### What this does not tell us

Nothing above logs anyone in. The whole gate (§7) is still to run, and Half B cannot run at all until
`apiBaseUrl` has a value.

---

## 10. Result — B1 is answered (Half A)

**Half A passed on 2026-08-13.** Login completes on-device, the access token is a JWT rather than an
opaque string, `tokenType` is `Bearer`, renewal is silent, and logout clears both the credentials and
the Auth0 web session. That closes B1's real question — _can a native client authenticate against
our tenant at all_ — and it exercised the two decisions most likely to have been wrong: D14's
`{bundleId}.auth0` callback scheme (login returned to the app) and D19's `useDPoP: false` (the token
came back `Bearer`).

**One error hit and resolved during the run**, worth recording because the message misdirects:

```text
Client ID <…> is not authorized to access resource <AUTH0_API_AUDIENCE>
```

It names the client and the resource, which reads like a client-side misconfiguration, but the
application and the audience string were both correct — a direct probe of
`GET /authorize` with the same `client_id`, `audience`, `redirect_uri` and a PKCE challenge returned
`302 → /u/login`, i.e. Auth0 accepted the request. It was an Auth0-side association between the
application and the API, and it cleared once that was in place. **If it reappears, probe `/authorize`
directly before touching app code** — a `302` to the login page proves the app, the audience and the
callback are all fine and the problem is in the tenant.

### Half B is not run, and that is recorded rather than assumed

`GET /api/v2/me`, and the 401 checks against a missing and a garbage token, need
`EXPO_PUBLIC_API_BASE_URL` — empty locally and unset on EAS, because there is no deployment. The app
throws before the fetch, by design. So:

- [x] Login completes on-device
- [x] Access token is a **JWT**, and `tokenType` is **`Bearer`**
- [x] Silent renewal — no login prompt
- [x] Logout
- [ ] `GET /api/v2/me` returns the same `sub` the web app shows ← **deferred to S3**
- [ ] 401 on no token and on a garbage token ← **deferred to S3**
- [ ] Web login verified unchanged ← **still worth doing** once, cheaply, in a browser
- [ ] Token lifetime restored to 86400 if it was lowered for the renewal check (D17)

**Folding Half B into S3 costs nothing**, because S3 is a server route called from the device: it
cannot run without a reachable server either. The first S3 call will exercise `withBearer` and the
whole Bearer path anyway, so nothing is skipped — it is only deferred to the stage that forces it.

---

## 11. What S2 hands to S3

- [x] **Auth0 is configured and working.** One tenant, one Native application (public client, PKCE,
      no secret), one API with RS256 and no scopes. The values live in `apps/mobile/.env` locally and
      in EAS environment variables for all three environments (D20) — never in git.
- [x] **The callback scheme is `{bundleIdentifier}.auth0`** (D14), verified in the generated
      `Info.plist` and again by a successful on-device login. S3 changes nothing here.
- [x] **`useDPoP: false` is load-bearing** (D19). The token came back `Bearer`; if a future SDK bump
      flips the default, the probe screen warns on `tokenType` and every v2 route starts 401ing.
- [x] **`withBearer` exists and is the only way to write a v2 route.** S3's token route is its second
      caller and the first one a learner depends on.
- [x] **`jose` is now a direct dependency of `apps/web`** — it was only transitive, and verifying
      tokens with a package present by accident is how auth breaks during an unrelated upgrade.
- [ ] ⚠️ **Half B of S2's gate is owed** (§10): `GET /api/v2/me` returning the right `sub`, plus the
      two 401 checks. S3 cannot run without a deployed server either, so run these first — they
      isolate the Bearer path before the token route adds ElevenLabs to the picture.
- [ ] ⚠️ **`EXPO_PUBLIC_API_BASE_URL` must be set in three places** once deployed: `apps/mobile/.env`,
      and EAS `preview` + `production`. Empty is deliberate; the app throws naming the variable.
- [ ] ⚠️ **`AUTH0_API_AUDIENCE` and `APP_BASE_URL` must be set on the deployment host.** Without the
      first, `getBearerOwnerId` fails **closed** and every v2 route 401s — which will look exactly
      like a broken token.
- [ ] ⚠️ **Restore the API token lifetime to 86400** if it was lowered to 300 for the renewal check
      (D17). A forgotten 300s lifetime still works; it just refreshes constantly.
- [ ] ⚠️ **Verify the web login is unchanged** — one sign-out/sign-in in a browser. `AUTH0_AUDIENCE`
      is still absent, which is what guarantees it, but the check is nearly free.
- [ ] **Still owed from S1, and S3's whole subject:** whether `onConnect`'s `conversationId` matches
      `/^conv_/`. The token route returns the authoritative id precisely because the SDK derives it
      (creation doc §9 B3).
- [ ] **Delete the throwaway S1 agent** once the token route replaces it. It is public
      (`enable_auth: false`) and its `max_duration_seconds` was raised to 7200 for probe runs.
- [x] **The `development` profile and dev client are still unbuilt** — inherited untouched from S1,
      now for the third stage running. S3 should build it if it wants a fast local loop.

---

## Sources

- **Read directly from published package source on 2026-08-13:** `react-native-auth0@5.11.0`
  (`src/plugin/withAuth0.ts` — `APPLICATION_ID_SUFFIX = '.auth0'`, `addIOSAuth0ConfigInInfoPList`,
  `withAppDelegate`), the basis for D14.
- [React Native Directory](https://reactnative.directory/api/libraries?search=auth0) —
  `react-native-auth0` `newArchitecture: true`, no compatibility-layer caveat.
- [Auth0 — Update access token lifetime](https://auth0.com/docs/secure/tokens/access-tokens/update-access-token-lifetime)
  — default **86400 s**, max 2,592,000; _Applications → APIs → Access Token Expiration_ (D17).
- [Auth0 — Mobile + API architecture](https://auth0.com/docs/get-started/architecture-scenarios/mobile-api/part-2)
  · [Auth0 Expo quickstart](https://auth0.com/docs/quickstart/native/react-native-expo)
- [Apple — `NSAllowsLocalNetworking`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)
  and [react-native#46957](https://github.com/facebook/react-native/issues/46957) — cleartext LAN
  fetches fail in Release builds (§6).
- In-repo: `apps/web/src/proxy.ts` (§4.1, verified) · `apps/web/src/lib/auth0.ts` and
  `lib/auth/session.ts` (what must stay unchanged) · `apps/web/src/lib/http.ts` +
  `packages/shared/src/api.ts` (the envelope and the contract) ·
  `docs/2026-08-12-expo-app-creation.md` §3 (the `/api/v2` design) and §9 B1 ·
  `docs/2026-08-13-expo-s1-background-audio.md` §4.2 and §12.
