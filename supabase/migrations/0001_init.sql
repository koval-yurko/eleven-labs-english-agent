-- 0001_init.sql — lessons schema (data-model.md)
-- Ownership is the Auth0 subject (text). RLS enabled here; policies land in 0003_rls.sql.

-- Enums ----------------------------------------------------------------------
create type lesson_status as enum ('pending', 'generating', 'ready', 'failed');
create type item_type as enum ('word', 'sentence', 'idiom');
create type skip_reason as enum ('non_english', 'gibberish', 'not_discrete', 'duplicate');

-- lessons --------------------------------------------------------------------
create table lessons (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,                                  -- Auth0 sub (FR-019)
  status lesson_status not null default 'pending',
  requested_item_count int not null default 0,
  accepted_item_count int not null default 0
    check (accepted_item_count <= 20),                     -- research R1 ceiling
  skipped_item_count int not null default 0,
  target_duration_seconds int not null,                    -- FR-012
  audio_duration_seconds int,                              -- measured after render (SC-003)
  script jsonb,                                            -- LessonScript; set when ready
  error_reason text,                                       -- set when failed (FR-016)
  model_id text,                                           -- reproducibility (Constitution III)
  prompt_version text,
  generation_input jsonb not null,                         -- raw submitted list
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- script present iff ready; error_reason present iff failed.
  constraint script_iff_ready check ((script is not null) = (status = 'ready')),
  constraint error_iff_failed check ((error_reason is not null) = (status = 'failed'))
);

create index lessons_owner_created_idx on lessons (owner_id, created_at desc);

-- source_items ---------------------------------------------------------------
create table source_items (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons (id) on delete cascade,
  owner_id text not null,                                  -- denormalized for RLS
  raw_text text not null,
  normalized_text text not null,
  item_type item_type not null,
  teachable boolean not null,
  skip_reason skip_reason,
  order_index int not null,
  covered boolean not null default false,                  -- set true when script covers it (FR-009)
  -- teachable rows have no skip reason; skipped rows must have one.
  constraint skip_reason_consistency check ((skip_reason is null) = teachable)
);

create index source_items_lesson_order_idx on source_items (lesson_id, order_index);
-- Dedup invariant within a lesson (FR-003): one teachable row per normalized text.
create unique index source_items_unique_teachable
  on source_items (lesson_id, normalized_text)
  where teachable;

-- lesson_audio ---------------------------------------------------------------
create table lesson_audio (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons (id) on delete cascade,
  owner_id text not null,                                  -- denormalized for RLS
  storage_path text not null,                              -- private bucket object path
  mime_type text not null,
  duration_seconds int not null,                           -- measured (SC-003)
  created_at timestamptz not null default now(),
  unique (lesson_id)
);

create index lesson_audio_lesson_idx on lesson_audio (lesson_id);

-- Enable RLS now (default-deny until policies are added in 0003_rls.sql).
alter table lessons enable row level security;
alter table source_items enable row level security;
alter table lesson_audio enable row level security;

-- keep updated_at fresh on lessons
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger lessons_set_updated_at
  before update on lessons
  for each row execute function set_updated_at();
