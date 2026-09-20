// Who is Document Control, and who is a plain user.
//
// Two kinds of account, and nothing in between:
//
//   dcc   Document Control. Uploads and deletes documents, creates projects and
//         organizations, and saves the cutting plan's stock and quantities.
//   user  Everyone else. A checker: reads the ISOs, reviews each line, and marks
//         it done. Changes nothing else.
//
// An account is Document Control if EITHER of these is true:
//
//   1. Its confirmed email is on the fixed list below. These accounts are Document
//      Control for good: nothing on the users page can demote them, so there is
//      always somebody who can get back in and no account can lock everyone out.
//   2. Its `app_metadata.role` is "dcc". That is what the users page sets when
//      Document Control makes someone else Document Control.
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
// To add a permanent Document Control account, add its address to the list. Keep
// "Confirm email" ON in the Supabase Auth settings while you do: with it off, an
// address is "confirmed" the moment somebody types it, so a listed address that
// has not been registered yet could be claimed by whoever signs up with it first.
// An address that is already registered cannot be claimed. Only list addresses you
// control.

export type AppRole = "dcc" | "user";

const DCC_EMAILS: readonly string[] = ["izzulamir1602@gmail.com"];

/** The slice of a Supabase user this needs -- so it works on the object `auth.getUser()` returns. */
interface RoleSubject {
  email?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
}

/** On the fixed list, with an address the account has proved it owns. Permanently Document Control. */
export function isBootstrapDcc(user: RoleSubject | null | undefined): boolean {
  const email = user?.email?.trim().toLowerCase();
  // `email_confirmed_at` is what makes the address proof of ownership, rather
  // than merely what someone typed.
  return Boolean(email && user?.email_confirmed_at && DCC_EMAILS.includes(email));
}

export function roleOf(user: RoleSubject | null | undefined): AppRole {
  if (isBootstrapDcc(user)) return "dcc";
  return user?.app_metadata?.role === "dcc" ? "dcc" : "user";
}

export function isDcc(user: RoleSubject | null | undefined): boolean {
  return roleOf(user) === "dcc";
}

export const ROLE_LABEL: Record<AppRole, string> = {
  dcc: "Document Control (DCC)",
  user: "User",
};

/**
 * For the server actions that change something. Throws, so a write that slips
 * past a hidden button still stops here: the buttons are a courtesy, this is
 * the lock.
 */
export function assertDcc(user: RoleSubject | null | undefined, what: string): void {
  if (!isDcc(user)) throw new Error(`Only Document Control (DCC) can ${what}.`);
}
