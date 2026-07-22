-- Tampa Bay Mahj — configurable public inquiry form (Phase 2f)
alter table public.settings add column if not exists inquiry_config jsonb not null default '{}'::jsonb;
