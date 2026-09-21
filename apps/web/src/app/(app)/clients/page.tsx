import type { Metadata } from "next";
import { getSessionUser } from "@/lib/session";
import { memberOrganizationsOf, visibleOrganizations } from "@/lib/access";
import { OrganizationPicker } from "@/components/org/OrganizationPicker";

export const metadata: Metadata = { title: "Organizations" };

// The first step of everyone's path: which organization. A plain user follows a
// card to that organization's projects; Document Control's choice opens the
// sidebar (see the layout, which shows this same picker in place of any page
// until Document Control has chosen).
export default async function OrganizationsPage() {
  const session = await getSessionUser();
  if (!session) return null;

  // Document Control chooses among ALL the organizations it belongs to, even while
  // one is already open -- this is where it comes to look at the others.
  const organizations = session.isDcc ? await memberOrganizationsOf(session.id) : await visibleOrganizations(session);

  return <OrganizationPicker organizations={organizations} isDcc={session.isDcc} />;
}
