# Supabase — schema & Auth0 trust

Same Supabase project as before; the data was reset to a fresh baseline.

## Migrations

Applied in order (`supabase/migrations/`) via `pnpm db:migrate`:

| File | Purpose |
| --- | --- |
| `0001_baseline.sql` | Fresh baseline. One owner-scoped example table (`health_pings`) carrying the learner's Auth0 `sub` in `owner_id`, with owner-only RLS. Add real tables as the app grows. |

## Two access paths

| Client | Key | RLS | Used for |
| --- | --- | --- | --- |
| `getServiceSupabase()` (`src/lib/supabase/server.ts`) | `SUPABASE_SERVICE_ROLE_KEY` | **bypassed** | Trusted server reads/writes. Ownership enforced **in code** — every query filters/stamps `owner_id`. |
| `getUserSupabase()` (`src/lib/supabase/user-client.ts`) | anon key + Auth0 access token | **enforced** | Token-scoped path. Wired but **dormant** until the Auth0 trust below is finished. |

> ⚠️ Today the app uses **only** the service-role client, so the `0001_baseline.sql` RLS
> policies are dormant (RLS is bypassed). Privacy relies on the repository's explicit
> `owner_id` filtering. `getUserSupabase()` only *enforces* RLS once Auth0 is trusted as a
> third-party auth provider. Check status in code via `isThirdPartyAuthConfigured()`.

## Trust Auth0 as a third-party auth provider (one-time, dashboard only)

Goal: make `auth.jwt() ->> 'sub'` in the RLS policies resolve to the learner's Auth0
subject. The code side is already done (`getUserSupabase()` forwards the token;
`auth0.ts` requests the API audience when `AUTH0_AUDIENCE` is set). What remains:

1. **Auth0 → APIs → Create API.** The Identifier (audience) becomes `AUTH0_AUDIENCE`.
2. **Auth0 → Actions → post-login** — add the Supabase-expected role claim:
   ```js
   exports.onExecutePostLogin = async (event, api) => {
     api.accessToken.setCustomClaim("role", "authenticated");
   };
   ```
3. **Supabase → Authentication → Third-Party Auth** — add Auth0 with the issuer URL
   (note the trailing slash), e.g. `https://YOUR-TENANT.eu.auth0.com/`.
4. **App env** — set `AUTH0_AUDIENCE` to match step 1 and restart.

After these, log in to mint a fresh JWT and verify a user-token query returns only the
caller's rows with a non-null `auth.jwt() ->> 'sub'`.
