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
| _(planned)_ user-token client | anon key + Auth0 access token | **enforced** | Any token-scoped path. Requires the Auth0 trust below. |

> ⚠️ Today the app uses **only** the service-role client, so the `0003_rls.sql`
> policies are dormant (RLS is bypassed). Privacy currently relies on the
> repository's explicit `owner_id` filtering, which is in place. RLS becomes a
> live second layer once the Auth0 trust (T037) is configured **and** a
> user-token client is introduced.

## T037 — trust Auth0 as a third-party auth provider

Goal: make `auth.jwt() ->> 'sub'` in the RLS policies resolve to the learner's
Auth0 subject, so a Supabase client carrying an Auth0 access token is scoped to
that learner.

### 1. Auth0 — issue a JWT access token with a `role` claim

Auth0 access tokens are opaque unless an **API audience** is requested, and
Supabase third-party auth expects a `role: "authenticated"` claim.

1. **Create an API** (Auth0 dashboard → Applications → APIs), e.g. identifier
   `https://supabase/encmuprissgvomvkdlbb`.
2. **Post-Login Action** (Actions → Triggers → post-login) to inject the role:

   ```js
   exports.onExecutePostLogin = async (event, api) => {
     api.accessToken.setCustomClaim("role", "authenticated");
   };
   ```

3. **Request the audience** so the SDK gets a JWT (not an opaque token):

   ```ts
   // apps/web/lib/auth0.ts
   new Auth0Client({
     authorizationParams: { audience: process.env.AUTH0_AUDIENCE },
   });
   ```

   Set `AUTH0_AUDIENCE=https://supabase/encmuprissgvomvkdlbb` in env.

### 2. Supabase — register the issuer

Dashboard → **Authentication → Sign In / Providers → Third-Party Auth** →
**Add provider** (Custom / Auth0). Supply the Auth0 issuer:

```
https://yurko-kovalchuk.eu.auth0.com/
```

Supabase validates incoming JWTs against this issuer's JWKS and exposes their
claims to `auth.jwt()`. The `sub` then matches the `owner_id` columns.

> This is a project-level setting — it cannot be applied via SQL/migrations.
> Configure it in the dashboard (or via the Supabase Management API).

### 3. App — add a token-scoped client

Keep `getServiceSupabase()` for trusted server work; add a parallel client that
forwards the Auth0 token so RLS is exercised:

```ts
import { createClient } from "@supabase/supabase-js";
import { getAuthToken } from "../auth/session"; // returns the Auth0 access token

export function getUserSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { accessToken: async () => (await getAuthToken()) ?? "" },
  );
}
```

`getAuthToken()` already exists in `apps/web/lib/auth/session.ts`.

### Verifying

With the trust in place and a user token attached, this should return only the
caller's rows (and `auth.jwt() ->> 'sub'` should be non-null):

```sql
select auth.jwt() ->> 'sub' as caller, count(*) from lessons;
```
