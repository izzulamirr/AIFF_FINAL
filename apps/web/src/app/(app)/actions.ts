"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { documents, findings, libraryItems, organizations, organizationMembers, projects } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVE_ORG_COOKIE, memberOrganizationsOf } from "@/lib/access";
import { assertDcc } from "@/lib/roles";
import { getSessionUser } from "@/lib/session";
import { getDb } from "@/lib/db";
import { markAllRead } from "@/lib/notifications";
import { isMissingTable } from "@/lib/progress";

const STORAGE_BUCKET = "documents";

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

// The bell's "Mark all read": every notice up to now is read, for this person only.
export async function markNotificationsRead() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  await markAllRead(session.id);
  revalidatePath("/", "layout");
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

// Document Control renames a client it belongs to. Only the name changes: the
// projects, drawings and memberships hang off the id, so nothing else moves. Same
// rule as choosing one -- an account can only touch a client it is a member of.
export async function renameOrganization(formData: FormData) {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (!session.isDcc) throw new Error("Only Document Control renames a client.");

  const organizationId = String(formData.get("organizationId") ?? "");
  const name = String(formData.get("name") ?? "").trim().replace(/\s+/g, " ");
  if (!organizationId || !name || name.length > 120) return;

  const member = await memberOrganizationsOf(session.id);
  if (!member.some((o) => o.id === organizationId)) throw new Error("Not a member of this organization.");

  await getDb().update(organizations).set({ name }).where(eq(organizations.id, organizationId));
  // The name is printed in the sidebar, the dashboard and the project lists.
  revalidatePath("/", "layout");
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

// Hides a project from every project list, or shows it again. Nothing is
// removed: its documents, checks and results stay exactly as they were, and its
// own URL still opens it.
export async function setProjectHidden(projectId: string, hidden: boolean) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");
  assertDcc(user, "hide projects");

  const db = getDb();
  const [project] = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error("Project not found.");
  const [membership] = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, project.organizationId), eq(organizationMembers.userId, user.id)))
    .limit(1);
  if (!membership) throw new Error("Not a member of this project's organization.");

  await db.update(projects).set({ hiddenAt: hidden ? new Date() : null }).where(eq(projects.id, projectId));
  revalidatePath("/dashboard");
  revalidatePath("/projects");
}

// Deletes a project and everything in it. Every table hanging off a project
// cascades from it -- documents (and their pages, jobs, results and tags),
// findings, the project's library entries -- so the rows go with one delete.
// What does NOT cascade is Storage: each document's and library file's object
// has to be removed by hand, or the bucket keeps them forever.
//
// Findings go first, explicitly. They cascade from the project, but
// doc_a_id/doc_b_id reference documents with no ON DELETE, so leaving them to
// the same statement as the documents relies on the order Postgres runs the
// cascades in.
export async function deleteProject(projectId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");
  assertDcc(user, "delete projects");

  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error("Project not found.");
  const [membership] = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, project.organizationId), eq(organizationMembers.userId, user.id)))
    .limit(1);
  if (!membership) throw new Error("Not a member of this project's organization.");

  const docPaths = await db.select({ path: documents.storagePath }).from(documents).where(eq(documents.projectId, projectId));
  // A database that never had the library created has no library_items table,
  // and so no library files to remove.
  const libraryPaths = await db
    .select({ path: libraryItems.storagePath })
    .from(libraryItems)
    .where(eq(libraryItems.projectId, projectId))
    .catch((err) => {
      if (isMissingTable(err)) return [];
      throw err;
    });
  const paths = [...docPaths, ...libraryPaths].map((r) => r.path).filter(Boolean);

  // Rows first, then files: a storage failure after this leaves orphaned files,
  // which is untidy, rather than a project whose documents point at nothing.
  await db.delete(findings).where(eq(findings.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));

  const admin = createAdminClient();
  // Storage takes removals in batches; 1000 is its per-call limit.
  for (let i = 0; i < paths.length; i += 1000) {
    const { error } = await admin.storage.from(STORAGE_BUCKET).remove(paths.slice(i, i + 1000));
    if (error && !/not found/i.test(error.message)) console.warn(`Deleted project ${project.name} but could not remove its files: ${error.message}`);
  }

  revalidatePath("/projects");
  revalidatePath("/dashboard");
  revalidatePath("/library");
}
