"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { roleOf } from "@/lib/roles";
import { assignUsername, findUserByUsername, isValidUsername, normalizeUsername, USERNAME_RULE } from "@/lib/usernames";

const MIN_PASSWORD_LENGTH = 8;

// Back to the form with a reason, keeping what was typed. The password is
// deliberately not carried: it would sit in the URL and the browser's history.
function back(fields: Record<string, string>): never {
  redirect(`/signup?${new URLSearchParams(fields).toString()}`);
}

// Creates an account. It creates a plain USER and nothing else -- there is no
// role field, so there is nothing to tamper with. Whether an account is
// Document Control is decided from its confirmed email (see lib/roles.ts), not
// from anything sent here.
export async function signup(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const username = normalizeUsername(String(formData.get("username") ?? ""));
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const typed = { name, username, email };
  if (!name) back({ ...typed, error: "Enter your full name." });
  if (!isValidUsername(username)) back({ ...typed, error: `Choose a username. ${USERNAME_RULE}` });
  // Checked BEFORE the account is created, so a taken name never leaves behind
  // an account with no username on it.
  if (await findUserByUsername(username)) back({ ...typed, error: `The username "${username}" is already taken.` });
  if (!email) back({ ...typed, error: "Enter your email address." });
  if (password.length < MIN_PASSWORD_LENGTH) {
    back({ ...typed, error: `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (password !== confirm) back({ ...typed, error: "The two passwords do not match." });

  const supabase = await createClient();
  // The name goes in `user_metadata`, which is display-only: an account holder
  // can edit it, so nothing that grants access is ever read from there.
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } });
  if (error) back({ ...typed, error: error.message });

  // Written with the service-role key: `app_metadata` is out of the account
  // holder's reach, which is the point (see lib/usernames.ts). If it fails the
  // account still exists and signs in by email; Document Control can set the
  // username from the Users page.
  if (data.user) {
    try {
      await assignUsername(data.user.id, username);
    } catch (err) {
      console.error("signup: account created but the username was not saved", err);
    }
  }

  // With email confirmation off, Supabase signs the new account straight in.
  // Every new sign-up is a plain User (see lib/roles.ts) -- the "dcc" branch
  // only fires for the handful of addresses already listed there, in case one
  // of them registers before anyone has manually created its account.
  if (data.session) redirect(roleOf(data.user) === "dcc" ? "/dashboard" : "/clients");

  redirect(`/login?message=${encodeURIComponent("Check your email to confirm your account, then log in.")}`);
}
