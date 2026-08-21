# Login and the auth flow — the repair

**2026-08-21.** Three screenshots from a device, all saying the same thing:

```
state: signed out        token: —
sub: —
api: https://eleven-labs-english-agent.vercel.app
The stored credentials instance does not contain a refresh token.
16:23:39 getCredentials failed: The stored credentials instance does not contain a refresh token.
```

and, on the words page:

```
0 items                              checked 19:41  ⟳
The stored credentials instance does not contain a refresh token.
[ Try again ]
```

Three hours apart, same sentence. **Try again** could not produce anything else, and there was no
sign-in button anywhere in the app to press instead.

---

## 1. What was actually broken: there was no login flow

The app had no sign-in screen. `app/auth.tsx` — the S2 gate instrument, reached from a small
`Account →` link at the bottom of the lessons list — held **the only `authorize()` call in the
codebase**. Every product screen simply assumed a session existed and copied the same four lines:

```ts
const { getCredentials } = useAuth0();
const accessToken = useCallback(async () => {
  const credentials = await getCredentials();
  return credentials?.accessToken ?? null;
}, [getCredentials]);
```

Five copies, in `lesson-items/index.tsx`, `lesson-items/[id].tsx`, `lessons/index.tsx`,
`lessons/[id]/index.tsx`, `probe.tsx`, plus `lib/tutor-session.tsx`. None of them could tell "this
request failed" from "there is no session", so a credentials failure was rendered as a **load
error** — the credentials manager's own sentence, under a count of zero, with a retry button.

That is why the state was terminal rather than annoying:

| | before |
|---|---|
| signed out at launch | product screens mount and fail |
| unrenewable credentials | the same red sentence on every screen, forever |
| the way to sign in | a link at the bottom of a screen that will not load |
| a dead Keychain entry | never removed — survives app kill and device restart |

## 2. Why there was no refresh token

`getCredentials()` renews an expired access token **using the refresh token**. With no refresh
token there is nothing to renew with, and iOS's credentials manager throws `NO_REFRESH_TOKEN`.

The app asks for one correctly — `scope: "openid profile email offline_access"` — and the SDK
forwards it (verified through `NativeWebAuthProvider.authorize` → `finalizeScope` → the bridge →
`builder.scope(value)` in `NativeBridge.swift`). So the request is not the problem; the **grant** is.
Auth0 drops `offline_access` silently unless BOTH of these are on:

1. **Auth0 → APIs → `AUTH0_API_AUDIENCE` → Settings → Allow Offline Access.**
2. **Auth0 → Applications → the Native app → Advanced Settings → Grant Types → Refresh Token.**

With either off the login **succeeds**, the app works until the access token expires, and only then
does it fail — which is exactly the "login works, then the app logs itself out later" symptom S2's
doc warned about (`docs/2026-08-13-expo-s2-auth0-bearer.md` §4).

⚠️ **Check both switches in the dashboard.** The app cannot set them, and the code below cannot make
a session survive without a refresh token — it can only make the failure recoverable and say so.

A device that reached this state before the fix keeps the dead entry until an app that removes it
runs (§3.1), or the app is deleted and reinstalled.

## 3. The repair — `apps/mobile/src/lib/auth.tsx`

One module owns the session: `AuthProvider` (state), `AuthGate` (what to draw), `useAccessToken()`
(the token), `useSession()` (sign in, sign out, who).

### 3.1 A signed-out app shows a sign-in screen

`AuthGate` wraps the navigator inside `app/_layout.tsx` rather than being a route, so there is no
window in which a product screen mounts and fires a request before a redirect takes it away — the
window this bug lived in. Signed out, the app renders one screen with one button.

`AuthProvider` also answers a question `Auth0Provider` leaves ambiguous. The SDK restores a user only
when it can find valid credentials **and** read an id token out of them; everything else leaves
`user` null with the stored entry untouched. That covers two opposite situations, and the bug lived
between them:

- **nothing usable stored** → remove it (it is what the next `getCredentials()` finds) and ask for a
  sign-in;
- **something renewable stored** → the launch just could not reach Auth0. Keep the refresh token and
  treat the learner as signed in; asking them to re-authenticate over a connection that is not
  working is the wrong answer.

`hasValidCredentials()` (`canRenew() || hasValid()`, both local reads) separates the two.

### 3.2 A terminal credentials failure ends the session instead of being reported

`useAccessToken()` classifies what `getCredentials()` throws:

| type | treated as |
|---|---|
| `NO_CREDENTIALS`, `NO_REFRESH_TOKEN`, `INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `DPOP_*` | terminal — clear the Keychain entry, drop to the sign-in screen with "Your session ended. Sign in to continue." |
| `RENEW_FAILED` | **retryable** — see below |
| `LARGE_MIN_TTL` | retried immediately without the TTL floor |
| anything else | passed through as an ordinary error |

**`RENEW_FAILED` is deliberately not terminal.** iOS has no separate network code for a renewal:
Auth0.swift reports an unreachable token endpoint exactly as it reports a revoked refresh token.
Treating it as terminal would let a tunnel or a captive portal *delete a working refresh token*, so
it becomes "Couldn't refresh your session — check your connection and try again."

### 3.3 One token source

`useAccessToken()` replaces all five copies. It also renews a token that is within 30s of expiring
rather than handing it out, and `apiFetch` retries a 401 **once** with `forceRefresh` — the two
clocks disagree, and a lesson that dies on a single 401 is the failure this app cannot afford. If
that renewal fails the original 401 is still what gets reported, because the token source has
already ended the session if it needed to.

### 3.4 Two smaller holes closed on the way

- **A backgrounded login used to brick sign-in.** It leaves the web-auth transaction open, and every
  later attempt fails with `TRANSACTION_ACTIVE_ALREADY` until the app is killed. `signIn` now
  cancels and retries once.
- **A signed-out app could leave the tutor talking.** LiveKit is already connected and needs no
  further token, so the conversation ran on with every control for it behind the gate. Signing out
  now ends the session (`lib/tutor-session.tsx`).

### 3.5 `/auth` is an instrument again, not the login screen

It keeps the diagnostics — token is a JWT (i.e. an audience was requested), renewal does not prompt,
`/api/v2/me` returns the right `sub`, 401 envelopes — and drives the same `signIn`/`signOut` the
gate does. It also shows the warning for §2: after a login that returned no refresh token it names
both dashboard switches, so the condition is visible at login rather than a day later.

## 4. Verifying on a device

1. **The reported state, healed.** Install over a build in the broken state → the sign-in screen
   appears (not a red words page), and one tap signs in.
2. **The tenant.** Sign in, open `Account →`. No warning banner means Auth0 issued a refresh token.
   A banner means §2 is still to do — and the session will end when the access token expires.
3. **Silent renewal.** With the API token lifetime lowered (S2 D17), press **Renew**: it must report
   a JWT and *not* open a browser sheet.
4. **Sign out.** `Account →` → **Log out** → the sign-in screen. Relaunch: still signed out, and the
   log is clean — nothing left in the Keychain to fail against.
5. **Airplane mode at launch** with a valid session: the app opens (load errors, no sign-in screen),
   and turning the radio back on recovers without a login.

## 5. What was not changed

The server. `apps/web/src/lib/auth/bearer.ts` verifies RS256 against the tenant JWKS with the issuer
trailing slash and a pinned algorithm, fails closed when unconfigured, and collapses every failure
to a 401 envelope. Nothing in the reported bug reaches it — the app never got far enough to send a
request.
