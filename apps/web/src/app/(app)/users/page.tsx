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
import { Alert, Badge, EmptyState, type Tone } from "@/components/ui/primitives";
import { IconTrash, IconUsers } from "@/components/ui/icons";
import { ClientAccess, type ClientOption } from "./ClientAccess";
import { RoleControl } from "./RoleControl";
import { AccountAction } from "./AccountAction";
import { ManageAccount } from "./ManageAccount";
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
        <section className="card card-flush">
          {/* The headline counts as one quiet line, with anything that needs
              attention picked out after it, instead of a row of large tiles. */}
          <div className="card-header flex-wrap gap-x-5 gap-y-2">
            <h2 className="card-title">
              Accounts <span className="font-normal text-muted-foreground">({accounts.length})</span>
            </h2>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{count("super_admin")} Super Admin</span>
              <span>{count("dcc")} Document Control</span>
              <span>{count("user")} Users</span>
              {deactivated > 0 && <span>{deactivated} deactivated</span>}
            </p>
            {(noUsername > 0 || unconfirmed > 0 || unassigned > 0) && (
              <p className="ml-auto flex flex-wrap gap-2">
                {noUsername > 0 && (
                  <Badge tone="warning" dot title="They sign in by email until one is set">
                    {noUsername} without a username
                  </Badge>
                )}
                {unconfirmed > 0 && (
                  <Badge tone="warning" dot title="They cannot sign in until the email is confirmed">
                    {unconfirmed} email not confirmed
                  </Badge>
                )}
                {unassigned > 0 && (
                  <Badge tone="warning" dot title="With no client they see an empty app">
                    {unassigned} with no client
                  </Badge>
                )}
              </p>
            )}
          </div>

          <div className="table-wrap">
            <table className="table [&_td]:align-middle">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Clients</th>
                  <th className="text-right">Lines</th>
                  <th>Last active</th>
                  <th className="w-px">
                    <span className="sr-only">Manage</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const label = a.name ?? a.email;
                  const memberOf: ClientOption[] = (membershipsByUser.get(a.id) ?? []).map((o) => ({ id: o.id, name: o.name }));
                  const isSelf = a.id === session.id;
                  // Your own account and a Super Admin fixed in code keep their
                  // role and stay switched on: see actions.ts.
                  const fixed = isSelf || a.bootstrap;
                  const initials = label
                    .replace(/@.*/, "")
                    .split(/[\s._-]+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((w) => w[0]!.toUpperCase())
                    .join("");
                  return (
                    <tr key={a.id} className={a.deactivated ? "bg-muted/40" : ""}>
                      <td>
                        <div className={`flex items-center gap-3 ${a.deactivated ? "opacity-60" : ""}`}>
                          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-link">
                            {initials || "?"}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium">
                              {label}
                              {isSelf && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {a.username ? `@${a.username}` : "no username"}
                              {a.name && <> &middot; {a.email}</>}
                            </p>
                            {(a.deactivated || !a.confirmed || !a.username) && (
                              <p className="mt-1 flex flex-wrap gap-1.5">
                                {a.deactivated && (
                                  <Badge tone="danger" dot>
                                    Deactivated
                                  </Badge>
                                )}
                                {!a.confirmed && (
                                  <Badge tone="warning" dot>
                                    Email not confirmed
                                  </Badge>
                                )}
                                {!a.username && !a.deactivated && (
                                  <Badge tone="warning" dot>
                                    No username
                                  </Badge>
                                )}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        <Badge tone={ROLE_TONE[a.role]} dot>
                          {ROLE_LABEL[a.role]}
                        </Badge>
                      </td>
                      <td className="min-w-[14rem]">
                        <ClientAccess
                          personLabel={label}
                          memberOf={memberOf}
                          assignable={assignable}
                          setAccess={setOrganizationAccess.bind(null, a.id)}
                        />
                      </td>
                      <td className="text-right tabular-nums">{a.linesChecked ?? "-"}</td>
                      {/* The full timestamp is kept on hover: the date is what is
                          scanned, the minute is what is occasionally asked. */}
                      <td className="whitespace-nowrap">
                        <p title={a.lastSignInAt ? when.format(a.lastSignInAt) : undefined}>
                          {a.lastSignInAt ? day.format(a.lastSignInAt) : <span className="text-muted-foreground">Never signed in</span>}
                        </p>
                        <p className="text-xs text-muted-foreground">Joined {day.format(a.createdAt)}</p>
                      </td>
                      <td className="text-right">
                        <ManageAccount
                          personLabel={label}
                          email={a.email}
                          usernameForm={
                            <form action={setUsername.bind(null, a.id)} className="flex items-center gap-2">
                              <span className="text-sm text-muted-foreground">@</span>
                              <input
                                name="username"
                                required
                                defaultValue={a.username ?? ""}
                                placeholder="username"
                                aria-label={`Username for ${label}`}
                                autoCapitalize="none"
                                spellCheck={false}
                                className="input input-sm flex-1"
                              />
                              <button className="btn btn-secondary btn-sm">Save</button>
                            </form>
                          }
                          role={
                            fixed ? (
                              <p className="flex items-center gap-2 text-sm">
                                <Badge tone={ROLE_TONE[a.role]} dot>
                                  {ROLE_LABEL[a.role]}
                                </Badge>
                                <span className="text-xs text-muted-foreground">
                                  {a.bootstrap ? "Set in code, so it can't be changed here." : "Your own role can't be changed by you."}
                                </span>
                              </p>
                            ) : (
                              <RoleControl personLabel={label} role={a.role} options={roleOptions} setRole={setUserRole.bind(null, a.id)} />
                            )
                          }
                          confirm={
                            a.confirmed ? undefined : (
                              <AccountAction
                                action={confirmAccountEmail.bind(null, a.id)}
                                className="btn btn-secondary btn-xs"
                                message={`Confirm ${a.email} for ${label}?\n\nThey will be able to sign in without opening the confirmation email. Only do this for an address you know is theirs.`}
                              >
                                Confirm email
                              </AccountAction>
                            )
                          }
                          danger={
                            fixed ? undefined : a.deactivated ? (
                              // Deleting is offered only once an account is off: see actions.ts.
                              <>
                                <AccountAction
                                  action={setAccountActive.bind(null, a.id, true)}
                                  className="btn btn-secondary btn-sm"
                                  message={`Reactivate ${label}?\n\nThey will be able to sign in again, with the same role and client access as before.`}
                                >
                                  Reactivate
                                </AccountAction>
                                <AccountAction
                                  action={deleteAccount.bind(null, a.id)}
                                  className="btn btn-danger btn-sm"
                                  message={`Are you sure you want to delete ${label}?\n\nThe account is removed permanently and cannot be restored. Their projects, drawings and reviews stay, but will no longer show who made them.`}
                                >
                                  <IconTrash size={13} />
                                  Delete
                                </AccountAction>
                              </>
                            ) : (
                              <AccountAction
                                action={setAccountActive.bind(null, a.id, false)}
                                className="btn btn-danger btn-sm"
                                message={`Deactivate ${label}?\n\nThey will be signed out and unable to sign in. Nothing is deleted: their reviews and uploads stay, and you can reactivate them at any time.`}
                              >
                                Deactivate account
                              </AccountAction>
                            )
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
