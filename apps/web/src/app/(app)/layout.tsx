import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { GuidedShell } from "@/components/shell/GuidedShell";
import { ClientPicker } from "@/components/client/ClientPicker";
import { IconLogOut } from "@/components/ui/icons";
import { activeOrganization, memberOrganizationsOf } from "@/lib/access";
import { ROLE_LABEL } from "@/lib/roles";
import { getSessionUser } from "@/lib/session";
import { leaveOrganization, signOut } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect("/login");

  const shellProps = { email: session.email, name: session.name, roleLabel: ROLE_LABEL[session.role] };

  // Every top bar carries the same plain "Sign out" button.
  const barSignOut = (
    <form action={signOut}>
      <button type="submit" className="btn btn-ghost btn-sm">
        <IconLogOut size={15} />
        Sign out
      </button>
    </form>
  );

  if (session.isDcc) {
    const organization = await activeOrganization(session);

    // CLIENT FIRST. Until Document Control has chosen the client it is
    // working in, it gets the picker and no navigation -- in place of whatever page
    // it asked for, so nothing is reachable, by link or by typed URL, before a
    // choice is made. Choosing sets a cookie and the request that follows gets the
    // full top bar, scoped to that client (see lib/access.ts).
    if (!organization) {
      return (
        <GuidedShell {...shellProps} readOnly={false} signOut={barSignOut}>
          <ClientPicker organizations={await memberOrganizationsOf(session.id)} isDcc />
        </GuidedShell>
      );
    }

    return (
      <AppShell
        {...shellProps}
        isDcc
        organization={{
          name: organization.name,
          switcher: (
            <form action={leaveOrganization}>
              <button
                type="submit"
                title="Work for a different client"
                className="rounded-md px-2 py-1 text-xs font-medium text-link transition-colors hover:bg-primary-soft"
              >
                Switch
              </button>
            </form>
          ),
        }}
        signOut={barSignOut}
      >
        {children}
      </AppShell>
    );
  }

  // A checker has no sidebar at all: client -> project -> line, each page
  // with its own way back.
  return (
    <GuidedShell {...shellProps} signOut={barSignOut}>
      {children}
    </GuidedShell>
  );
}
