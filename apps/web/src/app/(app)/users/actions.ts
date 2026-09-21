"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { organizationMembers } from "@easy/db";
import { activeOrganization, memberOrganizationsOf } from "@/lib/access";
import { getDb } from "@/lib/db";
import { isBootstrapDcc, isDcc, type AppRole } from "@/lib/roles";
import { getSessionUser } from "@/lib/session";
import { createAdminClient } from "@/lib/supabase/admin";

// Who is Document Control and who is a checker. Only Document Control can change
// it, and the rules below are what stop it locking everyone out or reaching further
// than it should -- the buttons hide the cases, these enforce them.
export async function setUserRole(userId: string, role: AppRole) {
  const session = await getSessionUser();
  if (!session) throw new Error("Not authenticated.");
  if (!session.isDcc) throw new Error("Only Document Control (DCC) can change who is Document Control.");
  if (role !== "dcc" && role !== "user") throw new Error("Unknown role.");
  // Nobody changes their own role: it is how an account demotes itself and, with
  // nobody else to undo it, leaves the app with no Document Control.
  if (userId === session.id) throw new Error("You can't change your own role.");

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error("That account was not found.");
  const target = data.user;

  // On the fixed list in roles.ts: Document Control for good. The stored role
  // would be ignored for it anyway, so refuse rather than pretend it worked.
  if (isBootstrapDcc(target)) throw new Error("This account is Document Control by configuration and can't be changed here.");

  // `app_metadata`, never `user_metadata`: only this service-role call can write
  // it, so the account holder cannot grant themselves the role.
  const { error: updateError } = await admin.auth.admin.updateUserById(userId, { app_metadata: { ...target.app_metadata, role } });
  if (updateError) throw new Error(`Could not change the role: ${updateError.message}`);

  // An account only sees the organizations it belongs to, so a newly promoted one
  // is added to the organization being worked in -- otherwise it would sign in to
  // an app with nothing in it. Demoting takes nothing away: membership is what a
  // checker reads by too, so the organizations stay exactly as they were and the
  // account carries on seeing the same ones, with less to do in them.
  if (role === "dcc") {
    const organization = await activeOrganization(session);
    if (organization) await addMembership(organization.id, userId, "admin");
  }

  revalidatePath("/users");
}

// ---------------------------------------------------------------------------
// Which organizations somebody is in.
//
// This is what a checker can SEE: the app shows an account the organizations it
// is a member of and nothing else (see lib/access.ts), so this page is where
// that is decided. Document Control hands out only the organizations it belongs
// to itself -- it cannot put somebody somewhere it has no part in, so the power
// to assign never reaches further than the power to look.
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
 * of switches, so "make it be this" is the shape the caller actually has, and
 * the checks either side of it are the same ones either way.
 */
export async function setOrganizationAccess(userId: string, organizationId: string, member: boolean) {
  const session = await getSessionUser();
  if (!session) throw new Error("Not authenticated.");
  if (!session.isDcc) throw new Error("Only Document Control (DCC) can change which organizations someone is in.");

  // Nobody takes away their own access: Document Control sees only the
  // organizations it belongs to, so the last one removed leaves an account that
  // can no longer reach the page it did it from. Granting to yourself is refused
  // for the same reason it is pointless -- you are already in everything you can
  // choose from here.
  if (userId === session.id) throw new Error("You can't change your own access to an organization.");

  // Not "is this a real organization" -- is it one the CALLER belongs to. That is
  // what stops Document Control handing out access it does not have itself.
  const organization = (await memberOrganizationsOf(session.id)).find((o) => o.id === organizationId);
  if (!organization) throw new Error("You are not a member of that organization.");

  const db = getDb();

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
