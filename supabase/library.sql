-- Library: reference files (legends, specifications, standards, templates,
-- datasheets) kept for a project, or for the whole organization.
--
-- Run this in the Supabase SQL editor. It is SAFE TO RUN MORE THAN ONCE, and it
-- only ADDS one table -- nothing existing is altered. The files themselves go in
-- the existing private "documents" bucket, under a `library/` prefix, so no new
-- bucket is needed.
--
-- Until it has been run the Library page shows a notice instead of the files.
--
-- project_id null = the OVERALL library, shared by every project in the
-- organization. Otherwise the file belongs to that one project.

create table if not exists library_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  category text not null,
  title text not null,
  description text,
  file_name text not null,
  storage_path text not null,
  size_bytes integer not null,
  content_type text,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_name text,
  created_at timestamptz not null default now(),
  constraint library_items_category_check
    check (category in ('legend','specification','standard','template','datasheet','other'))
);

create index if not exists library_items_org_idx on library_items (organization_id);
create index if not exists library_items_project_idx on library_items (project_id);

-- Row level security, the same model as line-progress.sql: readable by members of
-- the owning organization and nothing else. The app connects with a role that
-- bypasses RLS and decides who may write in its own server actions, so no
-- insert/update/delete policy is granted.
alter table library_items enable row level security;

drop policy if exists "org members can read library items" on library_items;
create policy "org members can read library items" on library_items
  for select using (
    exists (
      select 1 from organization_members m
      where m.organization_id = library_items.organization_id and m.user_id = auth.uid()
    )
  );
