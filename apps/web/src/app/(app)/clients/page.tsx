import type { Metadata } from "next";
import { getSessionUser } from "@/lib/session";
import { memberOrganizationsOf, visibleOrganizations } from "@/lib/access";
import { ClientPicker } from "@/components/client/ClientPicker";

export const metadata: Metadata = { title: "Clients" };

// Step 2 of everyone's path: which client. A checker follows a card to that
// client's projects; Document Control's choice opens the sidebar (see the
// layout, which shows this same picker in place of any page until Document
// Control has chosen).
export default async function ClientsPage() {
  const session = await getSessionUser();
  if (!session) return null;

  // Document Control chooses among ALL the clients it belongs to, even while one
  // is already open -- this is where it comes to look at the others.
  const clients = session.isDcc ? await memberOrganizationsOf(session.id) : await visibleOrganizations(session);

  return <ClientPicker organizations={clients} isDcc={session.isDcc} />;
}
