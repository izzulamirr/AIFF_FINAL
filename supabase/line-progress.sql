-- Line progress: the total line numbers Document Control states for a project,
-- and which lines a checker has marked as done.
--
-- Run this in the Supabase SQL editor. It is SAFE TO RUN MORE THAN ONCE, and it
-- only ADDS two tables -- nothing existing is altered, so nothing that works
-- today can be affected by it.
--
-- Until it has been run the app carries on as before: the Document Control
-- dashboard shows a notice in place of the progress section, and the "Mark as
-- done" button is left off the line page.
--
-- If you would rather create the tables with `pnpm --filter @easy/db db:push`
-- (the schema in packages/db/src/schema.ts matches this), still run the row
-- level security part below afterwards. Supabase exposes every table in the
-- public schema over its REST API, so a table without RLS is readable AND
-- writable by anyone holding the public anon key.

create table if not exists project_line_totals (
  project_id uuid primary key references projects(id) on delete cascade,
  total_lines integer not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint project_line_totals_total_check check (total_lines >= 0)
);

create table if not exists line_reviews (
  project_id uuid not null references projects(id) on delete cascade,
  line_key text not null,
  line_number text not null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_by_name text,
  reviewed_at timestamptz not null default now(),
  primary key (project_id, line_key)
);

-- Row level security, the same model as rls.sql: readable by members of the
-- owning organization, and nothing else. The app itself connects with a role that
-- bypasses RLS and enforces who may write in its own server actions, so no
-- insert/update/delete policy is granted -- through the REST API these tables are
-- read-only.
alter table project_line_totals enable row level security;
alter table line_reviews enable row level security;

drop policy if exists "org members can read line totals" on project_line_totals;
create policy "org members can read line totals" on project_line_totals
  for select using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = project_line_totals.project_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "org members can read line reviews" on line_reviews;
create policy "org members can read line reviews" on line_reviews
  for select using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = line_reviews.project_id and m.user_id = auth.uid()
    )
  );
