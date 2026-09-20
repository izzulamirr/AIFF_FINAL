import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { GuidedShell } from "@/components/shell/GuidedShell";
import { OrganizationPicker } from "@/components/org/OrganizationPicker";
import { IconLogOut } from "@/components/ui/icons";
import { activeOrganization, memberOrganizationsOf } from "@/lib/access";
import { ROLE_LABEL } from "@/lib/roles";
import { getSessionUser } from "@/lib/session";
import { leaveOrganization, signOut } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect("/login");

  const shellProps = { email: session.email, name: session.name, roleLabel: ROLE_LABEL[session.role] };

  // The bar with no sidebar carries a plain "Sign out" button; the sidebar has its own.
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

    // ORGANIZATION FIRST. Until Document Control has chosen the organization it is
    // working in, it gets the picker and no sidebar -- in place of whatever page
    // it asked for, so nothing is reachable, by link or by typed URL, before a
    // choice is made. Choosing sets a cookie and the request that follows gets the
    // sidebar, scoped to that organization (see lib/access.ts).
    if (!organization) {
      return (
        <GuidedShell {...shellProps} readOnly={false} signOut={barSignOut}>
          <OrganizationPicker organizations={await memberOrganizationsOf(session.id)} isDcc />
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
                title="Work in a different organization"
                className="rounded-md px-2 py-1 text-xs font-medium text-sidebar-accent transition-colors hover:bg-sidebar-hover"
              >
                Switch
              </button>
            </form>
          ),
        }}
        signOut={
          <form action={signOut}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="flex h-8 w-8 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-strong"
            >
              <IconLogOut size={16} />
            </button>
          </form>
        }
      >
        {children}
      </AppShell>
    );
  }

  // A plain user has no sidebar at all: Organization -> Project -> Line, each page
  // with its own way back.
  return (
    <GuidedShell {...shellProps} signOut={barSignOut}>
      {children}
    </GuidedShell>
  );
}
