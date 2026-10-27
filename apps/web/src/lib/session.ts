import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { isDccRole, isDeactivated, roleOf, type AppRole } from "@/lib/roles";

export interface SessionUser {
  id: string;
  email: string;
  /** The name given at sign-up, if any. Display only -- it is the account holder's to edit. */
  name: string | null;
  role: AppRole;
  /** Document Control's permissions. True for Super Admin too (see lib/roles.ts). */
  isDcc: boolean;
  /** Staff management: the users page. */
  isSuperAdmin: boolean;
}

// The signed-in person and what they may do, or null when signed out.
//
// `getUser()` asks Supabase's Auth server to vouch for the session; the cookie
// alone is not trusted (`getSession()` would be), so the email the role is
// derived from is one Supabase has checked.
//
// Wrapped in React's `cache` so the layout and the page it wraps -- which both
// need to know -- share one round trip to Auth per request instead of making
// one each.
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Deactivated by a Super Admin: signed out from this request on, even though
  // the token in the cookie has not expired yet.
  if (!user || isDeactivated(user)) return null;

  const role = roleOf(user);
  const fullName = (user.user_metadata as Record<string, unknown> | null | undefined)?.full_name;
  return {
    id: user.id,
    email: user.email ?? "",
    name: typeof fullName === "string" && fullName.trim() ? fullName.trim() : null,
    role,
    isDcc: isDccRole(role),
    isSuperAdmin: role === "super_admin",
  };
});
