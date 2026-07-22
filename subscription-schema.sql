-- Charleston CRM — multi-tenant SaaS layer
-- Run once on the new Charleston Supabase project (after the base schemas).

-- 1. Subscription + tenant fields on every account (each account = one studio/tenant)
alter table public.accounts add column if not exists slug text unique;
alter table public.accounts add column if not exists stripe_customer_id text;
alter table public.accounts add column if not exists stripe_subscription_id text;
alter table public.accounts add column if not exists subscription_status text not null default 'none';
  -- none | trialing | active | past_due | canceled | incomplete
alter table public.accounts add column if not exists subscription_period_end timestamptz;
create index if not exists accounts_stripe_customer_idx on public.accounts (stripe_customer_id);
create index if not exists accounts_stripe_sub_idx on public.accounts (stripe_subscription_id);

-- 2. Owner scoping: every tenant-scoped table gets owner_id (= accounts.id)
do $$
declare t text;
begin
  foreach t in array array[
    'students','slots','bookings','waitlist','inquiries','leads',
    'visits','pending_bookings','settings','profile','invites'
  ] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('alter table public.%I add column if not exists owner_id uuid', t);
      execute format('create index if not exists %I on public.%I (owner_id)', t||'_owner_idx', t);
    end if;
  end loop;
end $$;

-- 3. settings & profile were singletons; now one row per owner.
--    Drop the old single-row primary keys if present so multiple rows can exist.
--    (Safe no-ops if already migrated.)
