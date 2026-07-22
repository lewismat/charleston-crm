-- Tampa Bay Mahj — app settings (Phase 2d): holds the Stripe key server-side.
create table if not exists public.settings (
  id                text primary key default 'app',
  updated_at        timestamptz not null default now(),
  stripe_secret_key text
);
insert into public.settings (id) values ('app') on conflict (id) do nothing;
