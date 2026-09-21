import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { activeOrganization, memberOrganizationsOf, organizationMembershipsByUser } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { listAccounts, type AccountRow } from "@/lib/users";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, Badge, EmptyState, Stat } from "@/components/ui/primitives";
import { IconUsers } from "@/components/ui/icons";
import { OrganizationAccess, type OrgOption } from "./OrganizationAccess";
import { setOrganizationAccess, setUserRole } from "./actions";

export const metadata: Metadata = { title: "Users" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });
const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

// Everyone with an account, and who is Document Control. Document Control's only.
//
// A role changed here is stored on the account (see lib/roles.ts) and takes effect
// on that person's next request. Two kinds of account cannot be changed from here:
// your own, and the Document Control accounts fixed in the code -- see actions.ts.
export default async function UsersPage() {
  const session = await getSessionUser();
  if (!session) return null;
  if (!session.isDcc) redirect("/organizations");

  const organization = await activeOrganization(session);

  // What Document Control can hand out: the organizations it is in itself. Only
  // the id and the name cross to the client -- the rest of the row is the app's.
  const assignable: OrgOption[] = (await memberOrganizationsOf(session.id)).map((o) => ({ id: o.id, name: o.name }));
  const membershipsByUser = await organizationMembershipsByUser();

  let accounts: AccountRow[] = [];
  let loadError: string | null = null;
  try {
    accounts = await listAccounts();
  } catch (err) {
    loadError = err instanceof Error ? err.message : "The accounts could not be loaded.";
  }

  const dccCount = accounts.filter((a) => a.role === "dcc").length;
  const unconfirmed = accounts.filter((a) => !a.confirmed).length;
  const unassigned = accounts.filter((a) => (membershipsByUser.get(a.id)?.length ?? 0) === 0).length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Users" description="Everyone with an account. Choose who is Document Control and who is a checker." />

      {loadError && <Alert tone="danger">{loadError}</Alert>}

      {!loadError && accounts.length === 0 && (
        <div className="card">
          <EmptyState icon={<IconUsers />} title="No accounts yet" />
        </div>
      )}

      {accounts.length > 0 && (
        <>
          <div className="flex flex-wrap gap-4">
            <Stat label="Accounts" value={accounts.length} />
            <Stat label="Document Control" value={dccCount} />
            <Stat label="Checkers" value={accounts.length - dccCount} />
            {unconfirmed > 0 && <Stat label="Email not confirmed" value={unconfirmed} tone="warning" hint="cannot sign in yet" />}
            {unassigned > 0 && <Stat label="In no organization" value={unassigned} tone="warning" hint="they see an empty app" />}
          </div>

          <section className="card card-flush">
            <div className="table-wrap">
              <table className="table">
                {/* SIX columns, and it used to be eight -- enough to push the
                    table into a horizontal scroll, which puts the button that
                    changes somebody's role off the edge of the card. Two pairs
                    merged rather than anything being dropped: the confirmed
                    state belongs to the person, and "joined" is the same kind of
                    fact as "last seen". */}
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Organizations</th>
                    <th className="text-right">Lines</th>
                    <th>Activity</th>
                    <th className="w-px"></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const label = a.name ?? a.email;
                    const memberOf: OrgOption[] = (membershipsByUser.get(a.id) ?? []).map((o) => ({ id: o.id, name: o.name }));
                    return (
                      <tr key={a.id}>
                        {/* Only the EXCEPTION is shown. "Confirmed" on every row
                            was a column's width spent saying nothing; an account
                            that cannot sign in yet is worth seeing, and the stat
                            above counts them. */}
                        <td>
                          <p className="font-medium">{a.name ?? a.email}</p>
                          {a.name && <p className="text-xs text-muted-foreground">{a.email}</p>}
                          {!a.confirmed && (
                            <Badge tone="warning" dot className="mt-1">
                              Email not confirmed
                            </Badge>
                          )}
                        </td>
                        <td>
                          {a.role === "dcc" ? (
                            <Badge tone="info" dot>
                              Document Control
                            </Badge>
                          ) : (
                            <Badge>Checker</Badge>
                          )}
                        </td>
                        <td>
                          <OrganizationAccess
                            personLabel={label}
                            isSelf={a.id === session.id}
                            memberOf={memberOf}
                            assignable={assignable}
                            setAccess={setOrganizationAccess.bind(null, a.id)}
                          />
                        </td>
                        <td className="text-right tabular-nums">{a.linesChecked ?? "-"}</td>
                        {/* The full timestamp is kept on hover: the date is what
                            is scanned, the minute is what is occasionally asked. */}
                        <td className="whitespace-nowrap">
                          <p className="text-muted-foreground" title={a.lastSignInAt ? when.format(a.lastSignInAt) : undefined}>
                            {a.lastSignInAt ? day.format(a.lastSignInAt) : "Never signed in"}
                          </p>
                          <p className="text-xs text-muted-foreground">Joined {day.format(a.createdAt)}</p>
                        </td>
                        <td className="text-right">
                          {a.id === session.id ? (
                            <span className="text-xs text-muted-foreground">You</span>
                          ) : a.bootstrap ? (
                            <span className="text-xs text-muted-foreground" title="Document Control by configuration; not changed here">
                              Set in code
                            </span>
                          ) : a.role === "user" ? (
                            <form action={setUserRole.bind(null, a.id, "dcc")}>
                              <ConfirmButton
                                className="btn btn-secondary btn-xs"
                                message={`Make ${label} Document Control?\n\nThey will be able to upload and delete documents and create projects${organization ? `, and will be added to ${organization.name}` : ""}.`}
                              >
                                Make Document Control
                              </ConfirmButton>
                            </form>
                          ) : (
                            <form action={setUserRole.bind(null, a.id, "user")}>
                              <ConfirmButton
                                className="btn btn-secondary btn-xs"
                                message={`Make ${label} a checker?\n\nThey will no longer be able to upload or delete documents, and will review lines the way a checker does.`}
                              >
                                Make checker
                              </ConfirmButton>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="callout flex max-w-3xl flex-col gap-2">
            <p>
              <strong className="text-foreground">Organizations decide what somebody sees.</strong> An account reads the projects, drawings
              and library of the organizations listed against it, and nothing else &mdash; so an account in none sees an empty app. You can
              add someone to the organizations you belong to
              {assignable.length > 0 ? (
                <>
                  {" "}
                  (<span className="text-foreground">{assignable.map((o) => o.name).join(", ")}</span>)
                </>
              ) : null}
              , and to no others.
            </p>
            <p>
              A role takes effect on the person&apos;s next page load. Making someone Document Control also adds them to{" "}
              {organization ? <strong className="text-foreground">{organization.name}</strong> : "the organization you are working in"},
              since Document Control only sees the organizations it belongs to. Your own account, your own access, and the accounts fixed as
              Document Control in the code cannot be changed here.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
