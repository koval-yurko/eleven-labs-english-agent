-- 0003_rls.sql — owner-only Row-Level Security (FR-019, SC-005, research R7).
-- Policies key on the Auth0 subject exposed as `auth.jwt() ->> 'sub'` once Supabase
-- is configured to trust the Auth0 issuer as a third-party auth provider.
-- These are defense-in-depth beneath server-side owner-scoped queries.

-- lessons --------------------------------------------------------------------
create policy "lessons owner select"
  on lessons for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "lessons owner insert"
  on lessons for insert
  with check (owner_id = auth.jwt() ->> 'sub');

create policy "lessons owner update"
  on lessons for update
  using (owner_id = auth.jwt() ->> 'sub')
  with check (owner_id = auth.jwt() ->> 'sub');

-- source_items ---------------------------------------------------------------
create policy "source_items owner select"
  on source_items for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "source_items owner insert"
  on source_items for insert
  with check (owner_id = auth.jwt() ->> 'sub');

create policy "source_items owner update"
  on source_items for update
  using (owner_id = auth.jwt() ->> 'sub')
  with check (owner_id = auth.jwt() ->> 'sub');

-- lesson_audio ---------------------------------------------------------------
create policy "lesson_audio owner select"
  on lesson_audio for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "lesson_audio owner insert"
  on lesson_audio for insert
  with check (owner_id = auth.jwt() ->> 'sub');
