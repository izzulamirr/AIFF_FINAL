import { sql } from "drizzle-orm";
import { lineReviews } from "@easy/db";
import { getDb } from "@/lib/db";
import { isMissingTable } from "@/lib/progress";
import { isBootstrapSuperAdmin, isDeactivated, roleOf, type AppRole } from "@/lib/roles";
import { allUsers, usernameOf } from "@/lib/usernames";

// Every account, for the users page.
//
// The accounts live in Supabase Auth, not in this app's tables, so they are read
// through its admin API with the service-role key -- which is why this is server
// only and why only Document Control's page calls it.

export interface AccountRow {
  id: string;
  email: string;
  /** What the person signs in with; null until one is assigned (they can still sign in by email). */
  username: string | null;
  /** The name given at sign-up. Display only: the account holder can edit it. */
  name: string | null;
  role: AppRole;
  /** Super Admin by the fixed list in roles.ts -- cannot be changed from the page. */
  bootstrap: boolean;
  confirmed: boolean;
  /** Switched off by a Super Admin: cannot sign in until switched back on. */
  deactivated: boolean;
  lastSignInAt: Date | null;
  createdAt: Date;
  /** Lines this person has marked done; null if the progress tables do not exist yet. */
  linesChecked: number | null;
}

// How many lines each person has marked done, by account. Null when the progress
// tables have not been created yet (see lib/progress.ts) -- shown as "-", not 0.
async function linesCheckedByUser(): Promise<Map<string, number> | null> {
  try {
    const rows = await getDb()
      .select({ userId: lineReviews.reviewedBy, n: sql<number>`count(*)::int` })
      .from(lineReviews)
      .groupBy(lineReviews.reviewedBy);
    return new Map(rows.filter((r) => r.userId).map((r) => [r.userId as string, r.n]));
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

const ROLE_ORDER: Record<AppRole, number> = { super_admin: 0, dcc: 1, user: 2 };

export async function listAccounts(): Promise<AccountRow[]> {
  const [users, checked] = await Promise.all([allUsers(), linesCheckedByUser()]);

  return users
    .map((user): AccountRow => {
      const fullName = (user.user_metadata as Record<string, unknown> | null | undefined)?.full_name;
      return {
        id: user.id,
        email: user.email ?? "",
        username: usernameOf(user),
        name: typeof fullName === "string" && fullName.trim() ? fullName.trim() : null,
        role: roleOf(user),
        bootstrap: isBootstrapSuperAdmin(user),
        confirmed: Boolean(user.email_confirmed_at),
        deactivated: isDeactivated(user),
        lastSignInAt: user.last_sign_in_at ? new Date(user.last_sign_in_at) : null,
        createdAt: new Date(user.created_at),
        linesChecked: checked ? (checked.get(user.id) ?? 0) : null,
      };
    })
    // Active accounts first; then Super Admin, Document Control, users; by name within each.
    .sort(
      (a, b) =>
        Number(a.deactivated) - Number(b.deactivated) ||
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        (a.name ?? a.email).localeCompare(b.name ?? b.email)
    );
}
