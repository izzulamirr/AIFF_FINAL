import { cache } from "react";
import { cookies } from "next/headers";
import { asc, eq } from "drizzle-orm";
import { organizationMembers, organizations, projects } from "@easy/db";
import { getDb } from "@/lib/db";
import type { SessionUser } from "@/lib/session";

type Organization = typeof organizations.$inferSelect;

/** Where Document Control's chosen organization is remembered between requests. */
export const ACTIVE_ORG_COOKIE = "easy_org";

// The organizations a Document Control account belongs to. Cached for the
// request: the layout, the page it wraps and the picker all ask, and one query
// answers all three.
export const memberOrganizationsOf = cache(async (userId: string): Promise<Organization[]> => {
  const rows = await getDb()
    .select({ organization: organizations })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId));
  return rows.map((row) => row.organization);
});

// The organization Document Control chose to work in, or null if it has not
// chosen one yet -- which is what sends it to the organization picker before it
// gets a sidebar.
//
// The cookie only NARROWS the view: it is checked against the account's real
// memberships on every request, so a cookie naming an organization the account
// does not belong to (edited by hand, or left over after being removed) counts
// as no choice at all. It can never widen what somebody can reach.
export async function activeOrganization(session: Pick<SessionUser, "id" | "isDcc">): Promise<Organization | null> {
  if (!session.isDcc) return null;
  const id = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  if (!id) return null;
  return (await memberOrganizationsOf(session.id)).find((o) => o.id === id) ?? null;
}

// The organizations a person can READ.
//
// Document Control sees the organization it is working in, and -- before it has
// chosen one -- the ones it belongs to. A plain user sees them all: a user's
// whole job is to check what Document Control has uploaded, and there is nobody
// to add them to an organization -- so gating what they can read on membership
// would leave every new account looking at an empty app.
//
// This is about reading only. Writing is decided by role (see roles.ts) AND, for
// Document Control, by membership of the project's organization.
export async function visibleOrganizations(session: Pick<SessionUser, "id" | "isDcc">): Promise<Organization[]> {
  if (!session.isDcc) return getDb().select().from(organizations);

  const active = await activeOrganization(session);
  return active ? [active] : memberOrganizationsOf(session.id);
}

// The projects of the organization Document Control is working in, in the order
// they were created -- stable, so a page that falls back to "the first" lands on
// the same one every time. Empty until an organization has been chosen.
export async function activeProjectsOf(session: Pick<SessionUser, "id" | "isDcc">): Promise<Array<{ id: string; name: string }>> {
  const organization = await activeOrganization(session);
  if (!organization) return [];
  return getDb()
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.organizationId, organization.id))
    .orderBy(asc(projects.createdAt), asc(projects.id));
}

/** Project names for a picker. Two projects can share a name, so a repeated one carries part of its id. */
export function projectOptions(list: Array<{ id: string; name: string }>): Array<{ id: string; label: string }> {
  return list.map((p) => ({
    id: p.id,
    label: list.filter((o) => o.name === p.name).length > 1 ? `${p.name} (${p.id.slice(0, 8)})` : p.name,
  }));
}
