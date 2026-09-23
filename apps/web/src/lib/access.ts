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
// MEMBERSHIP, for both kinds of account. Document Control sees the organization
// it is working in, and -- before it has chosen one -- the ones it belongs to. A
// checker sees the ones Document Control has PUT THEM IN, and nothing else.
//
// A checker used to see every organization in the app. That was not a decision
// about what a checker should read: nothing could add an account to an
// organization, so gating on membership would have left every account looking at
// an empty app. The users page can now add them (see users/actions.ts), so the
// reason is gone and the rule is the same one for everybody. An account in no
// organization sees a picker that says so rather than somebody else's refinery.
//
// This is about reading only. Writing is decided by role (see roles.ts) AND, for
// Document Control, by membership of the project's organization.
export async function visibleOrganizations(session: Pick<SessionUser, "id" | "isDcc">): Promise<Organization[]> {
  if (!session.isDcc) return memberOrganizationsOf(session.id);

  const active = await activeOrganization(session);
  return active ? [active] : memberOrganizationsOf(session.id);
}

// Whether this account may read that organization AT ALL -- which is membership,
// and deliberately NOT narrowed by Document Control's active choice. The choice
// is a view over what it can already reach; a page reached by its own URL is
// asking a different question ("is this mine to see") and must not be refused
// merely because something else is open.
//
// The list pages filter by `visibleOrganizations`, but a project or document URL
// is guessable and reaches a page directly, so that is where this is used.
export async function canReadOrganization(
  session: Pick<SessionUser, "id" | "isDcc">,
  organizationId: string
): Promise<boolean> {
  return (await memberOrganizationsOf(session.id)).some((o) => o.id === organizationId);
}

// Every account's organizations, keyed by account -- for the users page, which
// shows the whole table at once and would otherwise ask per row.
export async function organizationMembershipsByUser(): Promise<Map<string, Organization[]>> {
  const rows = await getDb()
    .select({ userId: organizationMembers.userId, organization: organizations })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .orderBy(asc(organizations.name));

  const byUser = new Map<string, Organization[]>();
  for (const row of rows) {
    const list = byUser.get(row.userId);
    if (list) list.push(row.organization);
    else byUser.set(row.userId, [row.organization]);
  }
  return byUser;
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
