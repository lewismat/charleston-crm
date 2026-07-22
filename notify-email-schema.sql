alter table public.settings add column if not exists notify_email text;
alter table public.settings add column if not exists resend_api_key text;
alter table public.settings add column if not exists from_email text;
