-- Notifications: how far each person has read them.
--
-- Run this in the Supabase SQL editor. It is SAFE TO RUN MORE THAN ONCE, and it
-- only ADDS one table.
--
-- The notifications themselves are not stored -- a drawing revision change is
-- worked out from the documents already uploaded. This table only remembers, per
-- person, the moment they last pressed "Mark all read".
--
-- Until it has been run the bell still shows revision changes, but every one
-- counts as unread and "Mark all read" is hidden.

create table if not exists notification_reads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now()
);

-- Same model as line-progress.sql: the app connects with a role that bypasses RLS
-- and does its own checks. Through the REST API a person can read only their own
-- row, and nothing can be written.
alter table notification_reads enable row level security;

drop policy if exists "read own notification watermark" on notification_reads;
create policy "read own notification watermark" on notification_reads
  for select using (user_id = auth.uid());
