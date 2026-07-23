-- ============================================================================
-- Charleston CRM — tenant isolation (Phase 1)
-- Adds owner_id to every studio-scoped table so one studio can never see
-- another's data. Safe to run more than once (idempotent).
-- The Charleston project currently has a single studio; Holly's real data
-- lives in a separate project. Existing rows are backfilled to the earliest
-- owner account.
-- ============================================================================

-- 1) accounts: every account belongs to a studio (owner). Owners point to self.
alter table accounts add column if not exists owner_id uuid;
update accounts set owner_id = id where owner_id is null and role = 'owner';
-- any staff still unlinked → attach to the earliest owner
update accounts a
   set owner_id = (select id from accounts o where o.role = 'owner' order by created_at asc limit 1)
 where a.owner_id is null;

-- 2) tenant data tables get owner_id
alter table students         add column if not exists owner_id uuid;
alter table slots            add column if not exists owner_id uuid;
alter table bookings         add column if not exists owner_id uuid;
alter table pending_bookings add column if not exists owner_id uuid;
alter table waitlist         add column if not exists owner_id uuid;
alter table inquiries        add column if not exists owner_id uuid;
alter table visits           add column if not exists owner_id uuid;
do $$ begin if to_regclass('public.invites') is not null then execute 'alter table invites add column if not exists owner_id uuid'; end if; end $$;

-- 3) profile & settings become per-owner (keep the existing text id PK)
alter table profile  add column if not exists owner_id uuid;
alter table settings add column if not exists owner_id uuid;

-- 4) backfill existing rows to the primary (earliest) owner
do $$
declare primary_owner uuid;
begin
  select id into primary_owner from accounts where role = 'owner' order by created_at asc limit 1;
  if primary_owner is not null then
    update students         set owner_id = primary_owner where owner_id is null;
    update slots            set owner_id = primary_owner where owner_id is null;
    update bookings         set owner_id = primary_owner where owner_id is null;
    update pending_bookings set owner_id = primary_owner where owner_id is null;
    update waitlist         set owner_id = primary_owner where owner_id is null;
    update inquiries        set owner_id = primary_owner where owner_id is null;
    update visits           set owner_id = primary_owner where owner_id is null;
    if to_regclass('public.invites') is not null then update invites set owner_id = primary_owner where owner_id is null; end if;
    update profile          set owner_id = primary_owner where owner_id is null;
    update settings         set owner_id = primary_owner where owner_id is null;
  end if;
end $$;

-- 5) indexes for scoped lookups
create index if not exists idx_students_owner  on students(owner_id);
create index if not exists idx_slots_owner     on slots(owner_id);
create index if not exists idx_bookings_owner  on bookings(owner_id);
create index if not exists idx_pending_owner   on pending_bookings(owner_id);
create index if not exists idx_waitlist_owner  on waitlist(owner_id);
create index if not exists idx_inquiries_owner on inquiries(owner_id);
create index if not exists idx_visits_owner    on visits(owner_id);
do $$ begin if to_regclass('public.invites') is not null then execute 'create index if not exists idx_invites_owner on invites(owner_id)'; end if; end $$;

-- 6) per-owner uniqueness for settings/profile so upserts can target owner_id
create unique index if not exists uq_settings_owner on settings(owner_id);
create unique index if not exists uq_profile_owner  on profile(owner_id);

-- 7) slug lookup for public per-studio pages (Phase 2 uses this)
create index if not exists idx_accounts_slug on accounts(slug);

-- ============================================================================
-- 8) Foreign keys required for PostgREST embeds (slots<->bookings/waitlist).
-- The reconstructed Charleston schema was missing these, which 500'd the
-- public calendar (/api/slots) and the admin schedule. Idempotent.
-- ============================================================================
do $$ begin
  if not exists (select 1 from pg_constraint where conname='bookings_slot_fk') then
    alter table bookings add constraint bookings_slot_fk foreign key (slot_id) references slots(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname='waitlist_slot_fk') then
    alter table waitlist add constraint waitlist_slot_fk foreign key (slot_id) references slots(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname='pending_slot_fk') then
    alter table pending_bookings add constraint pending_slot_fk foreign key (slot_id) references slots(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname='waitlist_booking_fk') then
    alter table waitlist add constraint waitlist_booking_fk foreign key (booking_id) references bookings(id) on delete set null;
  end if;
end $$;
notify pgrst, 'reload schema';
