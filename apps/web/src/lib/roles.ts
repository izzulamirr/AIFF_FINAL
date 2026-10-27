// Who is Super Admin, who is Document Control, and who is a plain user.
//
// Three kinds of account, each one able to do everything the one below it can:
//
//   super_admin  Super Admin. Everything Document Control can do, and the only
//                account that manages STAFF: the users page, where roles,
//                usernames and client access are given out -- Super Admin
//                included, so one Super Admin can make another.
//   dcc          Document Control. Uploads and deletes documents, creates projects
//                and organizations, and saves the cutting plan's stock and
//                quantities. Does not see the users page.
//   user         Everyone else. A checker: reads the ISOs, reviews each line, and
//                marks it done. Changes nothing else.
//
// Because Super Admin is Document Control and more, every check that asks "is this
// Document Control?" (`isDcc`, `session.isDcc`, `assertDcc`) answers yes for it.
// Only staff management asks the narrower question (`isSuperAdmin`).
//
// An account's role comes from EITHER of these:
//
//   1. Its confirmed email is on the fixed list below. These accounts are Super
//      Admin for good: nothing on the users page can demote them, so there is
//      always somebody who can get back in and no account can lock everyone out.
//   2. Its `app_metadata.role`: "super_admin" or "dcc". That is what the users page
//      sets.
//
// Nothing else counts. In particular the role is NEVER read from `user_metadata`:
// that is the account holder's own to edit (it is where the name given at sign-up
// goes), so a role taken from it would let anyone promote themselves.
// `app_metadata` is a different thing -- Supabase only lets the service-role key
// write it -- which is why it is safe to trust here.
//
// SERVER ONLY. The list must not reach the browser bundle, so client components
// take the role as a prop and import only the `AppRole` type from here (a type
// import is erased at compile time and pulls nothing in).
//
// To add a permanent Super Admin, add its address to the list. Keep "Confirm
// email" ON in the Supabase Auth settings while you do: with it off, an address is
// "confirmed" the moment somebody types it, so a listed address that has not been
// registered yet could be claimed by whoever signs up with it first. An address
// that is already registered cannot be claimed. Only list addresses you control.

export type AppRole = "super_admin" | "dcc" | "user";

export const APP_ROLES: readonly AppRole[] = ["super_admin", "dcc", "user"];

const SUPER_ADMIN_EMAILS: readonly string[] = ["izzulamir1602@gmail.com"];

/** The slice of a Supabase user this needs -- so it works on the object `auth.getUser()` returns. */
interface RoleSubject {
  email?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
}

/** On the fixed list, with an address the account has proved it owns. Permanently Super Admin. */
export function isBootstrapSuperAdmin(user: RoleSubject | null | undefined): boolean {
  const email = user?.email?.trim().toLowerCase();
  // `email_confirmed_at` is what makes the address proof of ownership, rather
  // than merely what someone typed.
  return Boolean(email && user?.email_confirmed_at && SUPER_ADMIN_EMAILS.includes(email));
}

export function roleOf(user: RoleSubject | null | undefined): AppRole {
  if (isBootstrapSuperAdmin(user)) return "super_admin";
  const stored = user?.app_metadata?.role;
  return stored === "super_admin" || stored === "dcc" ? stored : "user";
}

/** Document Control's permissions -- which Super Admin has too. */
export function isDccRole(role: AppRole): boolean {
  return role === "dcc" || role === "super_admin";
}

export function isDcc(user: RoleSubject | null | undefined): boolean {
  return isDccRole(roleOf(user));
}

export function isSuperAdmin(user: RoleSubject | null | undefined): boolean {
  return roleOf(user) === "super_admin";
}

export const ROLE_LABEL: Record<AppRole, string> = {
  super_admin: "Super Admin",
  dcc: "Document Control (DCC)",
  user: "User",
};

/** What each role can do, said where a role is chosen. */
export const ROLE_DESCRIPTION: Record<AppRole, string> = {
  super_admin: "Everything Document Control can do, plus staff management: roles, usernames and client access.",
  dcc: "Uploads and deletes documents, creates projects and runs the checks. No staff management.",
  user: "Reviews ISO lines and marks them checked. Read-only otherwise.",
};

// DEACTIVATED accounts.
//
// A Super Admin can switch an account off without deleting it: its reviews,
// uploads and username stay, and switching it back on restores it exactly. It is
// a Supabase ban (`banned_until` far in the future), so Supabase itself refuses
// the sign-in and the session refresh. A session already open would otherwise
// last until its token expires, so the app also treats a banned account as
// signed out on its very next request (see lib/session.ts).

export const DEACTIVATED = "This account has been deactivated. Contact your administrator.";

/** Long enough to mean "until switched back on" -- Supabase has no "forever". */
export const DEACTIVATED_BAN_DURATION = "876000h";

export function isDeactivated(user: { banned_until?: string | null } | null | undefined): boolean {
  const until = user?.banned_until;
  return Boolean(until && new Date(until).getTime() > Date.now());
}

/**
 * For the server actions that change something. Throws, so a write that slips
 * past a hidden button still stops here: the buttons are a courtesy, this is
 * the lock.
 */
export function assertDcc(user: RoleSubject | null | undefined, what: string): void {
  if (!isDcc(user)) throw new Error(`Only Document Control (DCC) can ${what}.`);
}
