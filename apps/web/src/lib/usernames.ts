import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

// Signing in by USERNAME.
//
// Supabase Auth only signs in by email (or phone) and password, so a username is
// a pointer to an account's email: the server finds the account carrying it and
// signs in with that account's address. The email stays on the account -- it is
// still what confirms the account, resets a password, and decides the fixed
// Document Control list in roles.ts.
//
// The username is kept in `app_metadata`, NOT `user_metadata`. Only the
// service-role key can write `app_metadata`, so an account holder cannot rename
// themselves to somebody else's username and take over their sign-in.
//
// SERVER ONLY: this uses the service-role key.

/** 3-32 characters: lower-case letters, digits, dot, dash, underscore; starts with a letter or digit. */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const USERNAME_RULE = "3-32 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.";

/** Usernames are case-insensitive: "JSmith" and "jsmith" are the same account. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

/** The username stored on an account, or null for one that has not been given one yet. */
export function usernameOf(user: { app_metadata?: Record<string, unknown> | null } | null | undefined): string | null {
  const value = user?.app_metadata?.username;
  return typeof value === "string" && value ? value : null;
}

const PER_PAGE = 200;
const MAX_PAGES = 25;

/** Every account, through the admin API. */
export async function allUsers(): Promise<User[]> {
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

/**
 * The account carrying this username, or null.
 *
 * A scan rather than an index: Supabase cannot query `app_metadata`, and a plant
 * team's accounts number in the tens. Move the username into an app table with a
 * unique index if that ever stops being true.
 */
export async function findUserByUsername(username: string): Promise<User | null> {
  const wanted = normalizeUsername(username);
  if (!wanted) return null;
  return (await allUsers()).find((u) => usernameOf(u) === wanted) ?? null;
}

/**
 * Give an account a username. Throws with a reason the form can show.
 *
 * Uniqueness is checked here, not by a database constraint (there is none on
 * `app_metadata`), so two accounts claiming the same name in the same instant
 * could both succeed. With accounts created one at a time by a small team that
 * is accepted rather than engineered around.
 */
export async function assignUsername(userId: string, raw: string): Promise<string> {
  const username = normalizeUsername(raw);
  if (!isValidUsername(username)) throw new Error(`That username is not allowed. ${USERNAME_RULE}`);

  const holder = await findUserByUsername(username);
  if (holder && holder.id !== userId) throw new Error(`The username "${username}" is already taken.`);

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error("That account was not found.");

  const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { ...data.user.app_metadata, username },
  });
  if (updateError) throw new Error(`Could not save the username: ${updateError.message}`);
  return username;
}
