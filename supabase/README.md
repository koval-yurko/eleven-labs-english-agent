# Supabase — schema, storage & Auth0 trust

Project ref: `encmuprissgvomvkdlbb` · region `eu-west-1`.

## Migrations

Applied in order (`supabase/migrations/`):

| File | Purpose |
| --- | --- |
| `0001_init.sql` | Core tables — `lessons`, `source_items`, `lesson_audio`. Each carries an `owner_id` holding the learner's Auth0 `sub`. |
| `0002_storage.sql` | Private `lesson-audio` Storage bucket for generated audio. |
| `0003_rls.sql` | Owner-only Row-Level Security. Policies key on `auth.jwt() ->> 'sub'` (the Auth0 subject). Defense-in-depth beneath server-side owner-scoped queries. |

## Two access paths

| Client | Key | RLS | Used for |
| --- | --- | --- | --- |
| `getServiceSupabase()` (`apps/web/lib/supabase/server.ts`) | `SUPABASE_SERVICE_ROLE_KEY` | **bypassed** | Trusted server writes/reads. Ownership enforced **in code** — every query filters/stamps `owner_id` explicitly. |
| `getUserSupabase()` (`apps/web/lib/supabase/user-client.ts`) | anon key + Auth0 access token | **enforced** | Token-scoped path. Code is in place; only **dormant** until the manual Auth0 trust below is finished. |

> ⚠️ Today the app uses **only** the service-role client, so the `0003_rls.sql`
> policies are dormant (RLS is bypassed). Privacy currently relies on the
> repository's explicit `owner_id` filtering, which is in place. The
> `getUserSupabase()` client exists and is wired, but it only *enforces* RLS once
> the manual Auth0 trust (T037) below is completed (so Auth0 issues a JWT and
> Supabase trusts the issuer). Until then it carries an opaque token that Supabase
> won't resolve to a `sub`. Check status in code via `isThirdPartyAuthConfigured()`.

> 🗂️ **Storage key note:** Storage object keys can't contain `|`, so the owner
> segment of the audio path is sanitized (`auth0|abc` → `auth0_abc`, see
> `audioObjectKey` in `apps/web/lib/generation/storage.ts`). The dormant storage
> policy in `0002_storage.sql` compares `foldername[1]` to the raw `auth.jwt() ->>
> 'sub'`; if user-token Storage access is ever enabled, update that policy to
> compare against the **sanitized** owner segment (or switch the key scheme).

## T037 — trust Auth0 as a third-party auth provider

Goal: make `auth.jwt() ->> 'sub'` in the RLS policies resolve to the learner's
Auth0 subject, so a Supabase client carrying an Auth0 access token is scoped to
that learner.

### What's already done (code side) ✅

The application changes for T037 are implemented and committed — nothing more to
write:

- **Token-scoped client** — `getUserSupabase()` in
  `apps/web/lib/supabase/user-client.ts` forwards the Auth0 access token via
  `accessToken: async () => (await getAuthToken()) ?? ""`.
- **Conditional audience** — `apps/web/lib/auth0.ts` requests the API audience
  (so Auth0 issues a JWT instead of an opaque token) **only when** `AUTH0_AUDIENCE`
  is set: `new Auth0Client({ authorizationParameters: { audience, scope: "..." } })`.
  Leaving the env var unset keeps login working exactly as before.
- **Config probe** — `isThirdPartyAuthConfigured()` reports whether the audience
  env is present.
- **RLS migrations** — `0003_rls.sql` is applied; verify with `pnpm rls:smoke`
  (asserts RLS enabled + ≥1 policy on every owned table).

What remains is **dashboard configuration only** — see the checklist below.

### Manual steps to finalize (one-time, in dashboards) 🔧

These cannot be applied via SQL/migrations or code; do them in order. Until all
are complete, `getUserSupabase()` carries an opaque token Supabase can't resolve,
so RLS stays dormant and privacy relies on the service-role repository's
explicit `owner_id` filtering (already enforced).

- [ ] **1. Auth0 — create an API (audience).**
  Auth0 dashboard → **Applications → APIs → Create API**. Identifier (audience),
  e.g. `https://supabase/encmuprissgvomvkdlbb`. This identifier becomes
  `AUTH0_AUDIENCE`.

- [ ] **2. Auth0 — add the `role` claim via a Post-Login Action.**
  Auth0 dashboard → **Actions → Triggers → post-login**. Supabase third-party
  auth expects `role: "authenticated"`:

  ```js
  exports.onExecutePostLogin = async (event, api) => {
    api.accessToken.setCustomClaim("role", "authenticated");
  };
  ```

  Deploy the Action and ensure it's attached to the post-login flow.

- [ ] **3. Supabase — register Auth0 as a third-party auth provider.**
  Supabase dashboard → **Authentication → Sign In / Providers → Third-Party Auth**
  → **Add provider** (Custom / Auth0). Issuer URL (note the trailing slash):

  ```
  https://yurko-kovalchuk.eu.auth0.com/
  ```

  Supabase validates incoming JWTs against this issuer's JWKS and exposes their
  claims to `auth.jwt()`, so `sub` matches the `owner_id` columns. (Alternatively
  apply via the Supabase Management API — it is a project-level setting.)

- [ ] **4. App env — set the audience.**
  Add to `apps/web/.env.local` (and the deployment env), matching step 1:

  ```bash
  AUTH0_AUDIENCE=https://supabase/encmuprissgvomvkdlbb
  ```

  Restart the app. On next login Auth0 issues a JWT access token (not an opaque
  one), `isThirdPartyAuthConfigured()` returns `true`, and `getUserSupabase()`
  becomes a live RLS-enforced client.

### Verifying

After the four steps, log in to mint a fresh token, then query through a
user-token client (`getUserSupabase()`). It should return only the caller's rows
and a non-null subject:

```sql
select auth.jwt() ->> 'sub' as caller, count(*) from lessons;
```

`caller` being non-null confirms Supabase is trusting the Auth0 JWT; row counts
scoped to that learner confirm the `0003_rls.sql` policies are now live.
