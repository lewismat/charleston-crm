-- Tampa Bay Mahj — lead pipeline (Phase 2b)
-- Additive. Adds a lead/student status to the existing students table.
alter table public.students
  add column if not exists status text not null default 'student'
    check (status in ('lead','student'));

create index if not exists students_status_idx on public.students (status);
