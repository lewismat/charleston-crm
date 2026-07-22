-- Tampa Bay Mahj — configurable card + archive (Phase 2c)
-- Additive only.
alter table public.profile
  add column if not exists links   jsonb not null default '[]'::jsonb,
  add column if not exists details jsonb not null default '[]'::jsonb;

alter table public.students
  add column if not exists archived boolean not null default false;
create index if not exists students_archived_idx on public.students (archived);
