import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { activeOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { listAccounts, type AccountRow } from "@/lib/users";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, Badge, EmptyState, Stat } from "@/components/ui/primitives";
import { IconUsers } from "@/components/ui/icons";
import { setUserRole } from "./actions";

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

  let accounts: AccountRow[] = [];
  let loadError: string | null = null;
  try {
    accounts = await listAccounts();
  } catch (err) {
    loadError = err instanceof Error ? err.message : "The accounts could not be loaded.";
  }

  const dccCount = accounts.filter((a) => a.role === "dcc").length;
  const unconfirmed = accounts.filter((a) => !a.confirmed).length;

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
          </div>

          <section className="card card-flush">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Email</th>
                    <th>Lines checked</th>
                    <th>Last sign-in</th>
                    <th>Joined</th>
                    <th className="w-px"></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const label = a.name ?? a.email;
                    return (
                      <tr key={a.id}>
                        <td>
                          <p className="font-medium">{a.name ?? a.email}</p>
                          {a.name && <p className="text-xs text-muted-foreground">{a.email}</p>}
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
                          {a.confirmed ? (
                            <Badge tone="success" dot>
                              Confirmed
                            </Badge>
                          ) : (
                            <Badge tone="warning" dot>
                              Not confirmed
                            </Badge>
                          )}
                        </td>
                        <td className="tabular-nums">{a.linesChecked ?? "-"}</td>
                        <td className="whitespace-nowrap text-muted-foreground">{a.lastSignInAt ? when.format(a.lastSignInAt) : "Never"}</td>
                        <td className="whitespace-nowrap text-muted-foreground">{day.format(a.createdAt)}</td>
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

          <p className="callout max-w-3xl">
            A role takes effect on the person&apos;s next page load. Making someone Document Control also adds them to{" "}
            {organization ? <strong className="text-foreground">{organization.name}</strong> : "the organization you are working in"}, since
            Document Control only sees the organizations it belongs to. Your own account, and the accounts fixed as Document Control in the
            code, cannot be changed here.
          </p>
        </>
      )}
    </div>
  );
}
