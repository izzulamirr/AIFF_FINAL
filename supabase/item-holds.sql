-- BOM items marked ON HOLD or PENDING by a person.
--
-- Run this in the Supabase SQL editor. It is SAFE TO RUN MORE THAN ONCE, and it
-- only ADDS one table.
--
-- Until it has been run, holds the DRAWING prints (HOLD / TBA / TBC on a BOM row)
-- and instruments with no hook-up data are still shown as pending -- only the
-- "Mark pending" control on a BOM row is left off.

create table if not exists item_holds (
  document_id uuid not null references documents(id) on delete cascade,
  item_key text not null,
  project_id uuid not null references projects(id) on delete cascade,
  status text not null,
  remark text not null,
  marked_by uuid references auth.users(id) on delete set null,
  marked_by_name text,
  marked_at timestamptz not null default now(),
  primary key (document_id, item_key),
  constraint item_holds_status_check check (status in ('pending','hold'))
);

create index if not exists item_holds_project_idx on item_holds(project_id);

-- Same model as line-progress.sql: readable by members of the owning
-- organization; written only through the app's own server actions.
alter table item_holds enable row level security;

drop policy if exists "org members can read item holds" on item_holds;
create policy "org members can read item holds" on item_holds
  for select using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = item_holds.project_id and m.user_id = auth.uid()
    )
  );
