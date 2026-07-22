-- One-time: sweep existing inquiries into Students as Leads (deduped, non-destructive).
insert into public.students (first_name, last_name, email, phone, status, tags, source, notes)
select distinct on (lower(i.email))
  i.first_name, i.last_name, lower(i.email), i.phone, 'lead', 'lead', 'website inquiry',
  coalesce(i.event_type,'') || case when coalesce(i.event_date,'') <> '' then ' — ' || i.event_date else '' end
from public.inquiries i
where coalesce(i.email,'') <> ''
  and not exists (select 1 from public.students s where lower(s.email) = lower(i.email))
order by lower(i.email), i.submitted_at desc
returning first_name, last_name, email, status;
