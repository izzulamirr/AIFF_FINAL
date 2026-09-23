"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { organizations, organizationMembers, projects } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_ORG_COOKIE, memberOrganizationsOf } from "@/lib/access";
import { assertDcc } from "@/lib/roles";
import { getSessionUser } from "@/lib/session";
import { getDb } from "@/lib/db";

// A month, so Document Control is not asked again on every visit -- signing out
// forgets it sooner. Not a secret and not a permission: it is checked against the
// account's memberships each time it is read (see lib/access.ts).
const activeOrgCookie = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 30,
};

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // The next person to sign in on this browser starts at the organization picker.
  (await cookies()).delete(ACTIVE_ORG_COOKIE);
  redirect("/login");
}

// Document Control picks the organization it is working in. Only one it belongs
// to can be picked: the choice narrows what it sees, it does not grant access.
export async function selectOrganization(formData: FormData) {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (!session.isDcc) throw new Error("Only Document Control chooses an organization to work in.");

  const organizationId = String(formData.get("organizationId") ?? "");
  const member = await memberOrganizationsOf(session.id);
  if (!member.some((o) => o.id === organizationId)) throw new Error("Not a member of this organization.");

  (await cookies()).set(ACTIVE_ORG_COOKIE, organizationId, activeOrgCookie);
  redirect("/dashboard");
}

// Back to the picker, to work in a different organization.
export async function leaveOrganization() {
  (await cookies()).delete(ACTIVE_ORG_COOKIE);
  redirect("/clients");
}

export async function createOrganization(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  assertDcc(user, "create organizations");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const db = getDb();
  const [org] = await db.insert(organizations).values({ name }).returning();
  await db.insert(organizationMembers).values({ organizationId: org.id, userId: user.id, role: "owner" });

  // Creating an organization is choosing it: the next thing to do is work in it.
  (await cookies()).set(ACTIVE_ORG_COOKIE, org.id, activeOrgCookie);
  redirect("/dashboard");
}

export async function createProject(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  assertDcc(user, "create projects");

  const organizationId = String(formData.get("organizationId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!organizationId || !name) return;

  const db = getDb();

  // Confirm membership before allowing project creation -- this is the
  // app-layer tenant check that stands in for RLS until Phase 0's RLS
  // policies are written directly in Supabase (see the architecture plan).
  //
  // It asks for THIS user's row. It used to fetch whichever member of the
  // organization came back first and compare that person to the caller, so in
  // an organization with more than one member it turned away real members
  // depending on row order.
  const [membership] = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, user.id)))
    .limit(1);
  if (!membership) throw new Error("Not a member of this organization.");

  const [project] = await db.insert(projects).values({ organizationId, name, createdBy: user.id }).returning();

  redirect(`/projects/${project.id}`);
}
