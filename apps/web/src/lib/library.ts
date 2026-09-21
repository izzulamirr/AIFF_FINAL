import { and, desc, eq, isNull } from "drizzle-orm";
import { libraryItems, organizationMembers } from "@easy/db";
import { getDb } from "@/lib/db";
import { isMissingTable } from "@/lib/progress";
import type { SessionUser } from "@/lib/session";

// The library: reference files that are looked up rather than reviewed --
// legends, client specifications, standards, templates, datasheets.
//
// Two levels, one table (see library_items in the schema):
//   the OVERALL library   project_id null   shared by every project of the organization
//   a PROJECT library     project_id set    that project's own
//
// Like the progress tables, it lives in a table supabase/library.sql creates. Until
// that has been run Postgres answers "undefined_table", which is reported as
// `null` -- "not set up yet" -- rather than taking the page down.

// The kinds and accepted file types live in libraryKinds.ts, which a client
// component can import; re-exported so server code has one place to look.
export * from "@/lib/libraryKinds";

export type LibraryItem = typeof libraryItems.$inferSelect;

/**
 * The files of one library, newest first: a project's own (`projectId` given) or
 * the organization's overall library (`projectId` null). Null when the table has
 * not been created yet.
 */
export async function libraryItemsOf(organizationId: string, projectId: string | null): Promise<LibraryItem[] | null> {
  try {
    return await getDb()
      .select()
      .from(libraryItems)
      .where(
        and(
          eq(libraryItems.organizationId, organizationId),
          projectId ? eq(libraryItems.projectId, projectId) : isNull(libraryItems.projectId)
        )
      )
      .orderBy(desc(libraryItems.createdAt));
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/**
 * May this person read this organization's library?
 *
 * The same rule as everywhere else that reads: MEMBERSHIP, whoever is asking
 * (see visibleOrganizations in access.ts). A checker used to read every
 * organization's library, because nothing could put an account in one; the users
 * page can now, so a checker reads the libraries of the organizations it is in
 * and no others. Writing is stricter and is decided in the actions.
 */
export async function canReadLibraryOf(session: Pick<SessionUser, "id" | "isDcc">, organizationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, session.id)))
    .limit(1);
  return Boolean(row);
}
