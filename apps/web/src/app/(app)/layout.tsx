import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { GuidedShell } from "@/components/shell/GuidedShell";
import { ClientPicker } from "@/components/client/ClientPicker";
import { IconLogOut } from "@/components/ui/icons";
import { activeOrganization, memberOrganizationsOf } from "@/lib/access";
import { ROLE_LABEL } from "@/lib/roles";
import { getSessionUser } from "@/lib/session";
import { notificationsFor } from "@/lib/notifications";
import { NotificationBell, type BellNotice } from "@/components/shell/NotificationBell";
import type { SessionUser } from "@/lib/session";
import { leaveOrganization, markNotificationsRead, signOut } from "./actions";

const noticeDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const rev = (r: string | null) => (r ? `Rev ${r}` : "an unread revision");

// The bell, or nothing. A notice that cannot be worked out must not take every
// page down with it, so a failure here is logged and the bell left off.
async function bell(session: SessionUser) {
  try {
    const { notices, unread, canMarkRead } = await notificationsFor(session);
    const items: BellNotice[] = notices.map((n) => ({
      key: `${n.projectId}:${n.lineNumber}`,
      href: `/projects/${n.projectId}?line=${encodeURIComponent(n.lineNumber)}`,
      projectName: n.projectName,
      lineNumber: n.lineNumber,
      change: `Revised: ${rev(n.fromRevision)} → ${rev(n.toRevision)}`,
      when: noticeDate.format(n.at),
      fileName: n.fileName,
      yourCheck: n.youCheckedAt ? `You checked this at Rev ${n.youCheckedAt} — re-check needed` : null,
      unread: n.unread,
    }));
    return <NotificationBell notices={items} unread={unread} markRead={canMarkRead ? markNotificationsRead : undefined} />;
  } catch (err) {
    console.error("notifications: could not be worked out", err);
    return null;
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect("/login");

  const shellProps = { email: session.email, name: session.name, roleLabel: ROLE_LABEL[session.role] };

  // Every top bar carries the same notification bell and plain "Sign out" button.
  const barSignOut = (
    <div className="flex items-center gap-1">
      {await bell(session)}
      <form action={signOut}>
        <button type="submit" className="btn btn-ghost btn-sm">
          <IconLogOut size={15} />
          Sign out
        </button>
      </form>
    </div>
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
        isSuperAdmin={session.isSuperAdmin}
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
