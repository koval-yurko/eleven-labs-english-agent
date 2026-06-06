-- 0002_storage.sql — private bucket for rendered lesson audio (research R5/R7).
-- Audio bytes are served only through short-lived signed URLs minted server-side
-- for the owner; the bucket is NOT public (Constitution V).

insert into storage.buckets (id, name, public)
values ('lesson-audio', 'lesson-audio', false)
on conflict (id) do nothing;

-- Objects are namespaced as `<owner_id>/<lesson_id>/<file>` so a storage RLS policy
-- can key on the first path segment. Owner-only access:
create policy "lesson audio owner read"
  on storage.objects for select
  using (
    bucket_id = 'lesson-audio'
    and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
  );

create policy "lesson audio owner write"
  on storage.objects for insert
  with check (
    bucket_id = 'lesson-audio'
    and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
  );
