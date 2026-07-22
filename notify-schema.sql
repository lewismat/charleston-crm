-- Tampa Bay Mahj — notifications + calendar settings (Phase 2e)
alter table public.settings add column if not exists twilio_account_sid  text;
alter table public.settings add column if not exists twilio_auth_token   text;
alter table public.settings add column if not exists twilio_from         text;
alter table public.settings add column if not exists calendar_token      text;
alter table public.settings add column if not exists google_client_id    text;
alter table public.settings add column if not exists google_client_secret text;
alter table public.settings add column if not exists ms_client_id        text;
alter table public.settings add column if not exists ms_client_secret    text;
alter table public.settings add column if not exists ms_tenant           text;
update public.settings set calendar_token = encode(gen_random_bytes(16),'hex')
  where id='app' and (calendar_token is null or calendar_token='');
