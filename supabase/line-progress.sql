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
  -- The drawing revision the check was made against, as printed in the title
  -- block. A later revision marks the check for RE-CHECK rather than erasing
  -- it. Null where the revision was not known, which never raises a re-check.
  revision text,
  primary key (project_id, line_key)
);

-- Separate from the create above, so a database where line_reviews already
-- exists gains the column too. Safe to run more than once.
alter table line_reviews add column if not exists revision text;

-- Every document the check was based on, as it stood when marked done. A later
-- revision of any of them puts the line back to re-check.
alter table line_reviews add column if not exists basis jsonb;

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

-- Check prints: CP-01..CP-03 sent back to the designer, then FINAL (zero errors),
-- which marks the line done. Each row is kept; the sequence is the record.
create table if not exists line_check_prints (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  line_key text not null,
  line_number text not null,
  kind text not null check (kind in ('cp', 'final')),
  seq integer not null,
  iso_revision text,
  iso_document_ids jsonb,
  error_count integer not null,
  issued_by uuid references auth.users(id) on delete set null,
  issued_by_name text,
  issued_at timestamptz not null default now()
);
create index if not exists line_check_prints_line_idx on line_check_prints (project_id, line_key);

-- Same model as line_reviews: readable by members of the owning organization only.
alter table line_check_prints enable row level security;
drop policy if exists "org members can read check prints" on line_check_prints;
create policy "org members can read check prints" on line_check_prints
  for select using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = line_check_prints.project_id and m.user_id = auth.uid()
    )
  );
