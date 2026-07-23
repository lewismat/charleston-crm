-- Charleston v3 — reminders + attendance
alter table bookings add column if not exists reminder_sent_at timestamptz;
alter table bookings add column if not exists attended boolean;
alter table settings add column if not exists reminder_hours int default 24;
alter table settings add column if not exists reminders_enabled boolean default true;
