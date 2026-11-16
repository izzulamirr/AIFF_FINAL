-- Where report findings sit on an ISO sheet, found by the vision fallback.
--
-- Run this in the Supabase SQL editor. It is SAFE TO RUN MORE THAN ONCE, and it
-- only ADDS one table.
--
-- The report marks each error on the drawing. Where the PDF has a text layer the
-- position is read from it for free and nothing is stored. Only a sheet with NO
-- text layer is sent to Claude to find its items, and the answer is kept here so
-- each item is paid for once, not every time the report is opened.
--
-- Until this has been run the markers still work, but such a sheet is sent again
-- each time its report is opened.

create table if not exists finding_locations (
  document_id uuid not null references documents(id) on delete cascade,
  page integer not null,
  item_key text not null,
  found boolean not null,
  x double precision,
  y double precision,
  w double precision,
  h double precision,
  model text,
  created_at timestamptz not null default now(),
  primary key (document_id, page, item_key)
);

-- Same model as the other tables: readable by members of the document's
-- organization, written only through the app's own server code.
alter table finding_locations enable row level security;

drop policy if exists "org members can read finding locations" on finding_locations;
create policy "org members can read finding locations" on finding_locations
  for select using (
    exists (
      select 1 from documents d
      join projects p on p.id = d.project_id
      join organization_members m on m.organization_id = p.organization_id
      where d.id = finding_locations.document_id and m.user_id = auth.uid()
    )
  );
