import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { organizations } from "@easy/db";
import { organizationMembershipsByUser } from "@/lib/access";
import { getDb } from "@/lib/db";
import { APP_ROLES, ROLE_DESCRIPTION, ROLE_LABEL, type AppRole } from "@/lib/roles";
import { getSessionUser } from "@/lib/session";
import { listAccounts, type AccountRow } from "@/lib/users";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, Badge, EmptyState, Stat, type Tone } from "@/components/ui/primitives";
import { IconTrash, IconUsers } from "@/components/ui/icons";
import { ClientAccess, type ClientOption } from "./ClientAccess";
import { RoleControl } from "./RoleControl";
import { AccountAction } from "./AccountAction";
import { CreateAccountForm } from "./CreateAccountForm";
import {
  confirmAccountEmail,
  createAccount,
  deleteAccount,
  setAccountActive,
  setOrganizationAccess,
  setUserRole,
  setUsername,
} from "./actions";

export const metadata: Metadata = { title: "Staff management" };

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });
const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

const ROLE_TONE: Record<AppRole, Tone> = { super_admin: "warning", dcc: "info", user: "neutral" };

// Everyone with an account, what role each holds and which clients each sees.
// Super Admin's only: Document Control is sent away from it like a checker is.
//
// A role changed here is stored on the account (see lib/roles.ts) and takes effect
// on that person's next request. Two kinds of account cannot have their role
// changed from here: your own, and the Super Admins fixed in the code -- see
// actions.ts.
export default async function UsersPage() {
  const session = await getSessionUser();
  if (!session) return null;
  if (!session.isSuperAdmin) redirect(session.isDcc ? "/dashboard" : "/clients");

  // Super Admin hands out any client. Only the id and the name cross to the
  // browser -- the rest of the row is the app's.
  const [allOrganizations, membershipsByUser] = await Promise.all([
    getDb().select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(asc(organizations.name)),
    organizationMembershipsByUser(),
  ]);
  const assignable: ClientOption[] = allOrganizations;

  let accounts: AccountRow[] = [];
  let loadError: string | null = null;
  try {
    accounts = await listAccounts();
  } catch (err) {
    loadError = err instanceof Error ? err.message : "The accounts could not be loaded.";
  }

  // Roles are counted over ACTIVE accounts: a deactivated Super Admin is not one
  // anybody can use.
  const count = (role: AppRole) => accounts.filter((a) => a.role === role && !a.deactivated).length;
  const deactivated = accounts.filter((a) => a.deactivated).length;
  const unconfirmed = accounts.filter((a) => !a.confirmed).length;
  const noUsername = accounts.filter((a) => !a.username).length;
  const unassigned = accounts.filter((a) => (membershipsByUser.get(a.id)?.length ?? 0) === 0).length;
  const roleOptions = APP_ROLES.map((value) => ({ value, label: ROLE_LABEL[value], description: ROLE_DESCRIPTION[value] }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Staff management"
        description="Everyone with an account. Choose each person's role and which clients they can see."
      />

      {loadError && <Alert tone="danger">{loadError}</Alert>}

      {/* What each role means, said once above the table rather than on every row. */}
      <section className="card card-flush">
        <div className="card-header">
          <h2 className="card-title">Roles</h2>
        </div>
        <dl className="grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {APP_ROLES.map((role) => (
            <div key={role} className="px-5 py-4">
              <dt>
                <Badge tone={ROLE_TONE[role]} dot>
                  {ROLE_LABEL[role]}
                </Badge>
              </dt>
              <dd className="mt-2 text-[0.8125rem] leading-relaxed text-muted-foreground">{ROLE_DESCRIPTION[role]}</dd>
            </div>
          ))}
        </dl>
      </section>

      <CreateAccountForm
        roles={APP_ROLES.map((value) => ({ value, label: ROLE_LABEL[value] }))}
        clients={assignable}
        createAccount={createAccount}
      />

      {!loadError && accounts.length === 0 && (
        <div className="card">
          <EmptyState icon={<IconUsers />} title="No accounts yet" />
        </div>
      )}

      {accounts.length > 0 && (
        <>
          <div className="flex flex-wrap gap-4">
            <Stat label="Accounts" value={accounts.length} />
            <Stat label="Super Admin" value={count("super_admin")} />
            <Stat label="Document Control" value={count("dcc")} />
            <Stat label="Users" value={count("user")} />
            {deactivated > 0 && <Stat label="Deactivated" value={deactivated} hint="cannot sign in" />}
            {noUsername > 0 && <Stat label="No username" value={noUsername} tone="warning" hint="signs in by email until set" />}
            {unconfirmed > 0 && <Stat label="Email not confirmed" value={unconfirmed} tone="warning" hint="cannot sign in until confirmed" />}
            {unassigned > 0 && <Stat label="Assigned to no client" value={unassigned} tone="warning" hint="they see an empty app" />}
          </div>

          <section className="card card-flush">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Clients</th>
                    <th className="text-right">Lines</th>
                    <th>Activity</th>
                    <th className="w-px">
                      <span className="sr-only">Account</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const label = a.name ?? a.email;
                    const memberOf: ClientOption[] = (membershipsByUser.get(a.id) ?? []).map((o) => ({ id: o.id, name: o.name }));
                    const isSelf = a.id === session.id;
                    return (
                      <tr key={a.id} className={a.deactivated ? "bg-muted/40 text-muted-foreground" : ""}>
                        <td>
                          <p className="font-medium">
                            {a.name ?? a.email}
                            {isSelf && <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>}
                          </p>
                          {a.deactivated && (
                            <Badge tone="danger" dot className="mt-1">
                              Deactivated
                            </Badge>
                          )}
                          {a.name && <p className="text-xs text-muted-foreground">{a.email}</p>}
                          {/* The sign-in name, editable in place. An account with
                              none still signs in by email, so it is a warning,
                              not a lock-out. */}
                          <form action={setUsername.bind(null, a.id)} className="mt-1.5 flex items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">@</span>
                            <input
                              name="username"
                              required
                              defaultValue={a.username ?? ""}
                              placeholder="username"
                              aria-label={`Username for ${label}`}
                              autoCapitalize="none"
                              spellCheck={false}
                              className="input h-7 w-36 text-xs"
                            />
                            <button className="btn btn-secondary btn-xs">Save</button>
                          </form>
                          {!a.username && (
                            <Badge tone="warning" dot className="mt-1">
                              No username
                            </Badge>
                          )}
                          {!a.confirmed && (
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <Badge tone="warning" dot>
                                Email not confirmed
                              </Badge>
                              <AccountAction
                                action={confirmAccountEmail.bind(null, a.id)}
                                className="btn btn-secondary btn-xs"
                                message={`Confirm ${a.email} for ${label}?\n\nThey will be able to sign in without opening the confirmation email. Only do this for an address you know is theirs.`}
                              >
                                Confirm email
                              </AccountAction>
                            </div>
                          )}
                        </td>
                        <td>
                          {/* Your own role and a Super Admin fixed in code are shown,
                              not offered: see actions.ts for why neither changes here. */}
                          {isSelf || a.bootstrap ? (
                            <div className="flex flex-col items-start gap-1">
                              <Badge tone={ROLE_TONE[a.role]} dot>
                                {ROLE_LABEL[a.role]}
                              </Badge>
                              <span className="text-xs text-muted-foreground">{a.bootstrap ? "Set in code" : "Your own role"}</span>
                            </div>
                          ) : (
                            <RoleControl personLabel={label} role={a.role} options={roleOptions} setRole={setUserRole.bind(null, a.id)} />
                          )}
                        </td>
                        <td>
                          <ClientAccess
                            personLabel={label}
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
                          {/* Not your own, and not a Super Admin fixed in code: see actions.ts. */}
                          {isSelf || a.bootstrap ? null : a.deactivated ? (
                            // Deleting is offered only once an account is off: see actions.ts.
                            <div className="flex items-start justify-end gap-2">
                              <AccountAction
                                action={setAccountActive.bind(null, a.id, true)}
                                className="btn btn-secondary btn-xs"
                                message={`Reactivate ${label}?\n\nThey will be able to sign in again, with the same role and client access as before.`}
                              >
                                Reactivate
                              </AccountAction>
                              <AccountAction
                                action={deleteAccount.bind(null, a.id)}
                                className="btn btn-danger btn-xs"
                                message={`Are you sure you want to delete ${label}?\n\nThe account is removed permanently and cannot be restored. Their projects, drawings and reviews stay, but will no longer show who made them.`}
                              >
                                <IconTrash size={13} />
                                Delete
                              </AccountAction>
                            </div>
                          ) : (
                            <AccountAction
                              action={setAccountActive.bind(null, a.id, false)}
                              className="btn btn-danger btn-xs"
                              message={`Deactivate ${label}?\n\nThey will be signed out and unable to sign in. Nothing is deleted: their reviews and uploads stay, and you can reactivate them at any time.`}
                            >
                              Deactivate
                            </AccountAction>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
