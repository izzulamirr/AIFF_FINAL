"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { documents, findingComments, findings, organizationMembers, organizations, projects, reportExports } from "@easy/db";
import { activeOrganization } from "@/lib/access";
import { getDb } from "@/lib/db";
import { isMissingTable } from "@/lib/progress";
import { APP_ROLES, DEACTIVATED_BAN_DURATION, isBootstrapSuperAdmin, isDcc, isDeactivated, type AppRole } from "@/lib/roles";
import { getSessionUser, type SessionUser } from "@/lib/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { assignUsername, findUserByUsername, isValidUsername, normalizeUsername, USERNAME_RULE } from "@/lib/usernames";

// Staff management: who has which role, what they sign in with, and which clients
// they see. Super Admin's alone -- Document Control does not reach any of it. The
// rules below are what stop it locking everyone out; the buttons hide the cases,
// these enforce them.

async function requireSuperAdmin(what: string): Promise<SessionUser> {
  const session = await getSessionUser();
  if (!session) throw new Error("Not authenticated.");
  if (!session.isSuperAdmin) throw new Error(`Only a Super Admin can ${what}.`);
  return session;
}

export async function setUserRole(userId: string, role: AppRole) {
  const session = await requireSuperAdmin("change roles");
  if (!APP_ROLES.includes(role)) throw new Error("Unknown role.");
  // Nobody changes their own role: it is how an account demotes itself and, with
  // nobody else to undo it, leaves the app with no Super Admin.
  if (userId === session.id) throw new Error("You can't change your own role.");

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error("That account was not found.");
  const target = data.user;

  // On the fixed list in roles.ts: Super Admin for good. The stored role would be
  // ignored for it anyway, so refuse rather than pretend it worked.
  if (isBootstrapSuperAdmin(target)) throw new Error("This account is Super Admin by configuration and can't be changed here.");

  // `app_metadata`, never `user_metadata`: only this service-role call can write
  // it, so the account holder cannot grant themselves the role.
  const { error: updateError } = await admin.auth.admin.updateUserById(userId, { app_metadata: { ...target.app_metadata, role } });
  if (updateError) throw new Error(`Could not change the role: ${updateError.message}`);

  // An account only sees the organizations it belongs to, so a newly promoted one
  // is added to the organization being worked in -- otherwise it would sign in to
  // an app with nothing in it. Its existing memberships are brought in line with
  // the new role either way (an uploader's row says "admin", a checker's "viewer").
  const db = getDb();
  const memberRole = role === "user" ? "viewer" : "admin";
  await db.update(organizationMembers).set({ role: memberRole }).where(eq(organizationMembers.userId, userId));
  if (role !== "user") {
    const organization = await activeOrganization(session);
    if (organization) await addMembership(organization.id, userId, memberRole);
  }

  revalidatePath("/users");
}

// Switch an account off, or back on. Nothing is deleted: the account, its
// username, its client access and everything it reviewed or uploaded stay as they
// are, so reactivating restores it exactly (see lib/roles.ts on how it works).
export async function setAccountActive(userId: string, active: boolean) {
  const session = await requireSuperAdmin("deactivate accounts");
  // Your own: the one account that could not then switch itself back on.
  if (userId === session.id) throw new Error("You can't deactivate your own account.");

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error("That account was not found.");
  // The fixed Super Admins are the way back in if every other one is lost.
  if (isBootstrapSuperAdmin(data.user)) throw new Error("This account is Super Admin by configuration and can't be deactivated.");

  const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: active ? "none" : DEACTIVATED_BAN_DURATION,
  });
  if (updateError) throw new Error(`Could not ${active ? "reactivate" : "deactivate"} the account: ${updateError.message}`);

  revalidatePath("/users");
}

// Delete an account for good. Only one already DEACTIVATED: switching it off first
// is the deliberate step that says "this person has gone", and deleting is offered
// only after it.
//
// The WORK stays. Reviews, item holds and library uploads already lose their
// author by themselves (`on delete set null`), and memberships go with the account
// (`cascade`). Projects, documents, findings and report exports point at the
// account WITHOUT that rule, so Supabase would refuse the delete -- their author is
// cleared here first, keeping the project or drawing itself. Cleared BEFORE the
// delete, and committed: Supabase deletes on its own connection and checks those
// rows as they stand. A finding comment
// cannot lose its author (the column is required), so an account that wrote any
// is refused rather than having its comments removed.
export async function deleteAccount(userId: string) {
  const session = await requireSuperAdmin("delete accounts");
  if (userId === session.id) throw new Error("You can't delete your own account.");

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error("That account was not found.");
  if (isBootstrapSuperAdmin(data.user)) throw new Error("This account is Super Admin by configuration and can't be deleted.");
  if (!isDeactivated(data.user)) throw new Error("Deactivate the account before deleting it.");

  const db = getDb();
  // The findings tables belong to a feature not built yet, and a database set up
  // without them has nothing there to clear.
  const unlessMissing = async <T,>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (isMissingTable(err)) return fallback;
      throw err;
    }
  };

  const comments = await unlessMissing(async () => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(findingComments).where(eq(findingComments.userId, userId));
    return row?.n ?? 0;
  }, 0);
  if (comments > 0) {
    throw new Error(`This account wrote ${comments} finding comment${comments === 1 ? "" : "s"}, which would be lost. Keep it deactivated instead.`);
  }

  // One statement each rather than one transaction: a missing table would abort
  // the whole transaction, and clearing an author twice is harmless if a later
  // step fails and the delete is tried again.
  await db.update(projects).set({ createdBy: null }).where(eq(projects.createdBy, userId));
  await db.update(documents).set({ uploadedBy: null }).where(eq(documents.uploadedBy, userId));
  await unlessMissing(() => db.update(findings).set({ assigneeId: null }).where(eq(findings.assigneeId, userId)), null);
  await unlessMissing(() => db.update(findings).set({ resolvedBy: null }).where(eq(findings.resolvedBy, userId)), null);
  await unlessMissing(() => db.update(reportExports).set({ generatedBy: null }).where(eq(reportExports.generatedBy, userId)), null);

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) throw new Error(`Could not delete the account: ${deleteError.message}`);

  revalidatePath("/users");
}

// Mark an account's email as confirmed, for someone who never received or never
// opened the confirmation email. Supabase then lets it sign in. The address is
// vouched for by the Super Admin rather than proved by a link, which is the
// Super Admin's call to make about staff they know.
export async function confirmAccountEmail(userId: string) {
  await requireSuperAdmin("confirm email addresses");
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { email_confirm: true });
  if (error) throw new Error(`Could not confirm the email: ${error.message}`);
  revalidatePath("/users");
}

/** What `createAccount` hands back to the form. */
export interface CreateAccountResult {
  ok: boolean;
  message: string;
}

const MIN_PASSWORD_LENGTH = 8;

// Create an account for somebody, ready to sign in: email already confirmed, role
// and clients already set. The Super Admin passes the username and password on
// to them.
//
// Returns a result rather than throwing, so the form can say what was wrong and
// keep what was typed.
export async function createAccount(formData: FormData): Promise<CreateAccountResult> {
  await requireSuperAdmin("create accounts");

  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const username = normalizeUsername(String(formData.get("username") ?? ""));
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "user") as AppRole;
  const organizationIds = formData.getAll("organizationId").map(String).filter(Boolean);

  if (!name) return { ok: false, message: "Enter the person's full name." };
  if (!isValidUsername(username)) return { ok: false, message: `Choose a username. ${USERNAME_RULE}` };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: "Enter a valid email address." };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: `The password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (!APP_ROLES.includes(role)) return { ok: false, message: "Choose a role." };
  // Checked BEFORE the account is created, so a taken name never leaves behind an
  // account with no username on it.
  if (await findUserByUsername(username)) return { ok: false, message: `The username "${username}" is already taken.` };

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    // Confirmed by the Super Admin creating it: no confirmation email, and the
    // account can sign in straight away.
    email_confirm: true,
    user_metadata: { full_name: name },
    // `app_metadata`: out of the account holder's reach (see lib/roles.ts).
    app_metadata: { username, ...(role === "user" ? {} : { role }) },
  });
  if (error || !data.user) {
    const taken = error?.code === "email_exists" || /already been registered/i.test(error?.message ?? "");
    return { ok: false, message: taken ? `An account with ${email} already exists.` : `Could not create the account: ${error?.message ?? "unknown error"}` };
  }

  // Only organizations that exist; a stale id from an old form is skipped, not fatal.
  if (organizationIds.length > 0) {
    const db = getDb();
    const real = await db.select({ id: organizations.id }).from(organizations).where(inArray(organizations.id, organizationIds));
    const memberRole = role === "user" ? "viewer" : "admin";
    for (const o of real) await addMembership(o.id, data.user.id, memberRole);
  }

  revalidatePath("/users");
  return { ok: true, message: `Created ${name}. They can sign in now as "${username}" with the password you set.` };
}

// The username somebody signs in with (see lib/usernames.ts). Your own included: a
// username grants nothing, it only names the account.
export async function setUsername(userId: string, formData: FormData) {
  await requireSuperAdmin("set usernames");
  await assignUsername(userId, String(formData.get("username") ?? ""));
  revalidatePath("/users");
}

// ---------------------------------------------------------------------------
// Which organizations somebody is in.
//
// This is what an account can SEE: the app shows it the organizations it is a
// member of and nothing else (see lib/access.ts), so this page is where that is
// decided. Super Admin hands out any organization, its own access included -- it
// can always give it back, so there is nothing to lock itself out of.
// ---------------------------------------------------------------------------

/** The membership row's own role. Mirrors the account: a checker reads, Document Control uploads. */
function memberRoleFor(target: { app_metadata?: Record<string, unknown> | null; email?: string | null; email_confirmed_at?: string | null }): string {
  return isDcc(target) ? "admin" : "viewer";
}

// Upserting rather than ignoring a clash: a row already there for a checker who
// has since become Document Control would otherwise keep saying "viewer" forever.
async function addMembership(organizationId: string, userId: string, role: string) {
  await getDb()
    .insert(organizationMembers)
    .values({ organizationId, userId, role })
    .onConflictDoUpdate({ target: [organizationMembers.organizationId, organizationMembers.userId], set: { role } });
}

/**
 * Turn one person's access to one organization on or off.
 *
 * One action rather than an add and a remove: the panel that calls it is a list
 * of switches, so "make it be this" is the shape the caller actually has.
 */
export async function setOrganizationAccess(userId: string, organizationId: string, member: boolean) {
  await requireSuperAdmin("change which organizations someone is in");

  const db = getDb();
  const [organization] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!organization) throw new Error("That organization was not found.");

  if (member) {
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data.user) throw new Error("That account was not found.");
    await addMembership(organizationId, userId, memberRoleFor(data.user));
  } else {
    await db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)));
  }

  revalidatePath("/users");
}
