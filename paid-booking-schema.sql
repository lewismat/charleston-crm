-- Tampa Bay Mahj — paid bookings (Phase 2i)
alter table public.slots add column if not exists price_cents integer not null default 0;

create table if not exists public.pending_bookings (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  slot_id    uuid not null references public.slots(id) on delete cascade,
  seats      int  not null default 1,
  payload    jsonb not null,
  session_id text,
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  status     text not null default 'pending' check (status in ('pending','paid','expired'))
);
create index if not exists pending_session_idx on public.pending_bookings (session_id);
create index if not exists pending_status_idx  on public.pending_bookings (status, expires_at);
alter table public.pending_bookings add column if not exists manage_token text;
