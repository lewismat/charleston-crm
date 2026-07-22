-- Tampa Bay Mahj — accounts, profile & student CRM (Phase 2a)
-- Additive only. Does not touch inquiries, visits, slots, bookings, or waitlist.
create extension if not exists pgcrypto;

-- Staff logins (Holly + any helpers). Passwords are scrypt-hashed by the app.
create table if not exists public.accounts (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  email         text not null unique,
  username      text not null unique,
  name          text not null,
  role          text not null default 'staff' check (role in ('owner','staff')),
  password_hash text not null,
  active        boolean not null default true,
  last_login    timestamptz
);

-- Holly's shareable profile card (single row keyed 'holly').
create table if not exists public.profile (
  id           text primary key default 'holly',
  updated_at   timestamptz not null default now(),
  display_name text,
  tagline      text,
  bio          text,
  credentials  text,
  offerings    text,
  photo_url    text,
  email        text,
  phone        text,
  instagram    text,
  shopmy       text,
  website      text
);
insert into public.profile (id) values ('holly') on conflict (id) do nothing;

-- Student CRM records.
create table if not exists public.students (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  first_name  text not null,
  last_name   text,
  email       text,
  phone       text,
  skill_level text not null default 'beginner'
                check (skill_level in ('beginner','advanced_beginner','intermediate','advanced')),
  tags        text,
  notes       text,
  birthday    date,
  source      text
);
create index if not exists students_email_idx on public.students (lower(email));
create index if not exists students_name_idx  on public.students (lower(last_name), lower(first_name));
