import { sql } from "drizzle-orm";
import type { User } from "@supabase/supabase-js";
import { lineReviews } from "@easy/db";
import { getDb } from "@/lib/db";
import { isMissingTable } from "@/lib/progress";
import { isBootstrapDcc, roleOf, type AppRole } from "@/lib/roles";
import { createAdminClient } from "@/lib/supabase/admin";

// Every account, for the users page.
//
// The accounts live in Supabase Auth, not in this app's tables, so they are read
// through its admin API with the service-role key -- which is why this is server
// only and why only Document Control's page calls it.

export interface AccountRow {
  id: string;
  email: string;
  /** The name given at sign-up. Display only: the account holder can edit it. */
  name: string | null;
  role: AppRole;
  /** Document Control by the fixed list in roles.ts -- cannot be changed from the page. */
  bootstrap: boolean;
  confirmed: boolean;
  lastSignInAt: Date | null;
  createdAt: Date;
  /** Lines this person has marked done; null if the progress tables do not exist yet. */
  linesChecked: number | null;
}

const PER_PAGE = 200;
const MAX_PAGES = 25;

async function allUsers(): Promise<User[]> {
  const admin = createAdminClient();
  const users: User[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(`Could not list the accounts: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < PER_PAGE) break;
  }
  return users;
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

export async function listAccounts(): Promise<AccountRow[]> {
  const [users, checked] = await Promise.all([allUsers(), linesCheckedByUser()]);

  return users
    .map((user): AccountRow => {
      const fullName = (user.user_metadata as Record<string, unknown> | null | undefined)?.full_name;
      return {
        id: user.id,
        email: user.email ?? "",
        name: typeof fullName === "string" && fullName.trim() ? fullName.trim() : null,
        role: roleOf(user),
        bootstrap: isBootstrapDcc(user),
        confirmed: Boolean(user.email_confirmed_at),
        lastSignInAt: user.last_sign_in_at ? new Date(user.last_sign_in_at) : null,
        createdAt: new Date(user.created_at),
        linesChecked: checked ? (checked.get(user.id) ?? 0) : null,
      };
    })
    // Document Control first, then by name.
    .sort((a, b) => (a.role === b.role ? (a.name ?? a.email).localeCompare(b.name ?? b.email) : a.role === "dcc" ? -1 : 1));
}
