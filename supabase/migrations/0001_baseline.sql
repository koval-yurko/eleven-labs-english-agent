-- 0001_baseline.sql — fresh baseline for the rebuilt app.
--
-- Starts from scratch (the old 0001–0007 lesson/live-story schema was retired). This carries
-- one owner-scoped example table so the scaffold can prove the Supabase + Auth0 owner/RLS
-- pattern end-to-end. Ownership is the Auth0 subject (text). Add real tables as the app grows.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- health_pings — example owner-scoped table used by the integration smoke test.
create table health_pings (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,                       -- Auth0 sub
  note text not null default '',
  created_at timestamptz not null default now()
);

create index health_pings_owner_created_idx on health_pings (owner_id, created_at desc);

-- Owner-only Row-Level Security. Policies key on the Auth0 subject exposed as
-- `auth.jwt() ->> 'sub'` once Supabase is configured to trust the Auth0 issuer as a
-- third-party auth provider (see supabase/README.md). Defense-in-depth beneath the
-- server-side service-role client's explicit owner_id filtering.
alter table health_pings enable row level security;

create policy "health_pings owner select"
  on health_pings for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "health_pings owner insert"
  on health_pings for insert
  with check (owner_id = auth.jwt() ->> 'sub');
