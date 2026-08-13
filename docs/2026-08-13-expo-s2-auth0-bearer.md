# S2 — Auth0 on a device, Bearer on the server (B1) · research

**Date:** created 2026-08-13 · **Status:** 🔲 **placeholder — not researched.**
**Enrich after: S1's gate is green.**

**Parents:** [build plan → S2](./2026-08-12-expo-build-plan.md) ·
[creation doc §9 B1](./2026-08-12-expo-app-creation.md) (de-risked in full) ·
[S1 research](./2026-08-13-expo-s1-background-audio.md).

---

## Why this file is empty

B1 is the **smallest** remaining risk — creation doc §9 B1 already established that every query runs
through the service-role client with explicit `owner_id` filtering, so nothing in the data path reads
the access token, and that the web login can be left byte-for-byte unchanged by verifying against a
separate `AUTH0_API_AUDIENCE`. Revised cost: ~half a day, most of it dashboard work.

So the research left is not "will this work" but "exactly which JWKS/verification code goes in
`apps/web/src/lib/auth/bearer.ts`, and how does the app hold and refresh credentials" — and the second
half depends on S1's answer. If S1 escalated to CallKit, the session lifecycle changed and token
refresh across a long backgrounded call is a different question than it is today.

## Inputs required from S1

- [ ] S1 verdict: plain background audio, or the CallKit branch? (changes the token-refresh story)
- [ ] Whether the app now runs for long periods backgrounded — how long can a session outlive an
      access token before the first refresh is needed?
- [ ] The shipped **`app.config.ts`** plugin list, which `react-native-auth0` is about to join —
      its `customScheme` must read the variant's scheme, never a literal
- [ ] The **three** bundle ids and their **three** schemes (S0/D7, decided — [S0 §2](./2026-08-13-expo-s0-scaffold-testflight.md#2-decisions--settled-2026-08-13)). The
      callback URL embeds both, so the one Auth0 Native application needs three callback and three
      logout URLs, comma-separated:
      `englishtutor://{domain}/ios/work.kovalchuk.yurii.english-tutor/callback` plus the
      `englishtutorpreview://…-preview/…` and `englishtutordev://…-dev/…` forms. The schemes differ
      per variant on purpose: two apps claiming one scheme leaves iOS to pick undefined.

## Already decided — do not re-derive

- **Do NOT set `AUTH0_AUDIENCE`.** `apps/web/src/lib/auth0.ts` reads it and would change the **web**
  login flow, which D4 forbids. Add a verification-only **`AUTH0_API_AUDIENCE`**, read solely by
  `getBearerOwnerId`. (`supabase/README.md` step 4 says to set `AUTH0_AUDIENCE` — that instruction
  belongs to the RLS activation path, which this port is not doing.)
- **A second Auth0 application**, type **Native** (public client, PKCE). It cannot reuse the Regular
  Web App's client.
- **RS256**, API identifier in URI form and **immutable once created**.
- **No scopes / no RBAC** — authorization is `sub`-based ownership; a scope model would be a second,
  redundant one.
- **`offline_access`** in the requested scope, or the learner re-authenticates mid-lesson.
- **`getOwnerId()` stays cookie-only.** The `/api/v2` namespace exists so the Bearer path never runs
  for the web app — "keep the web app as is" enforced structurally, not by care.

## Questions this research must answer

- [ ] The concrete `getBearerOwnerId` implementation: which JWKS library, caching/rotation of keys,
      clock skew, and the exact assertions — `alg: RS256`, `iss` with the **trailing slash**,
      `aud` = `AUTH0_API_AUDIENCE`. What does it return on a malformed/expired token, and what does
      the route do with `null`?
- [ ] Where does the token live on device — `react-native-auth0`'s credentials manager (Keychain)?
      What happens on app kill, on device restart, on biometrics-locked keychain items?
- [ ] Silent renewal: does `getCredentials()` refresh transparently, and what is the failure mode when
      the refresh token is revoked or rotated?
- [ ] Do we need a logout flow at S2, or does it belong to S7?
- [ ] How does every v2 route share the auth check without duplicating it (a wrapper, per-route call)?
- [ ] Testing: how is `GET /api/v2/me` exercised against a **local** dev server from a device, and
      against the deployed one?

## Gate

- [ ] Auth0 login completes on-device
- [ ] `getCredentials()` returns an access token that is a **JWT**, not opaque
- [ ] `GET /api/v2/me` with that Bearer returns the same `sub` the web app sees for that account
- [ ] Background the app past the token lifetime — `offline_access` renews silently
- [ ] Web login verified unchanged (log in on the web app after the server change)

The renewal check is not optional. A phone that re-prompts for login mid-lesson is not shippable.

## Enrichment checklist

1. Copy in S1's outputs and the current `app.json`.
2. Do the Auth0 dashboard steps as _research_: record the actual identifier, domain, client id and
   callback URL you will use, so S3 and S7 do not guess.
3. Pin the verification library and write the `bearer.ts` sketch here before writing it in the repo.
4. Flip the status line and update the build plan's Progress table.

## Sources to start from

- creation doc §9 B1 (the correction box especially) · build plan S2
- [Auth0 — Mobile + API architecture](https://auth0.com/docs/get-started/architecture-scenarios/mobile-api/part-2)
- [Auth0 Expo quickstart](https://auth0.com/docs/quickstart/native/react-native-expo) ·
  [react-native-auth0](https://www.npmjs.com/package/react-native-auth0)
- In-repo: `apps/web/src/lib/auth0.ts`, `supabase/README.md`
