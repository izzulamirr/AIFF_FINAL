"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DEACTIVATED, isDcc } from "@/lib/roles";
import { findUserByUsername } from "@/lib/usernames";

// The same words Supabase uses for a wrong password, so a mistyped username and
// a wrong password are indistinguishable -- the form does not confirm which
// usernames exist.
const INVALID = "Invalid login credentials";

export async function login(formData: FormData) {
  const supabase = await createClient();

  const identifier = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  // A username normally. An email is still accepted, so an account that has not
  // been given a username yet is not locked out -- a username cannot contain "@".
  let email = identifier;
  if (!identifier.includes("@")) {
    const account = await findUserByUsername(identifier);
    if (!account?.email) redirect(`/login?error=${encodeURIComponent(INVALID)}`);
    email = account.email;
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Supabase answers "banned" only once the password is right, so saying so
    // tells nobody anything they could not already sign in to find out.
    const message =
      error.code === "user_banned"
        ? DEACTIVATED
        : error.code === "email_not_confirmed"
          ? "Your email address has not been confirmed yet. Open the link in the confirmation email, or ask a Super Admin to confirm your account."
          : error.message;
    redirect(`/login?error=${encodeURIComponent(message)}`);
  }

  // Document Control (and Super Admin, which is Document Control and more) lands
  // on its dashboard; a plain User goes straight into the guided Organization ->
  // Project -> Features path, since it has no sidebar to reach the dashboard's
  // tool grid from.
  redirect(isDcc(data.user) ? "/dashboard" : "/clients");
}
