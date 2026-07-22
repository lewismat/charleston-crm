-- Tampa Bay Mahj — invite-only account creation (Phase 2h)
create table if not exists public.invites (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code       text not null unique,
  created_by uuid references public.accounts(id) on delete set null,
  note       text,
  used_at    timestamptz,
  used_by    uuid references public.accounts(id) on delete set null
);
