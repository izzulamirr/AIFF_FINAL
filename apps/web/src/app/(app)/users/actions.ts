"use server";

import { revalidatePath } from "next/cache";
import { organizationMembers } from "@easy/db";
import { activeOrganization } from "@/lib/access";
import { getDb } from "@/lib/db";
import { isBootstrapDcc, type AppRole } from "@/lib/roles";
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

  // A Document Control account only sees the organizations it belongs to, so a
  // newly promoted one is added to the organization being worked in -- otherwise
  // it would sign in to an app with nothing in it. Demoting takes nothing away: a
  // checker reads every organization regardless, and the membership is simply
  // there again if they are promoted later.
  if (role === "dcc") {
    const organization = await activeOrganization(session);
    if (organization) {
      await getDb().insert(organizationMembers).values({ organizationId: organization.id, userId, role: "admin" }).onConflictDoNothing();
    }
  }

  revalidatePath("/users");
}
