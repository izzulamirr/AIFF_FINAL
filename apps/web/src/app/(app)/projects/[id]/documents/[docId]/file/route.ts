import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { documents, projects } from "@easy/db";
import { canReadOrganization } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { createAdminClient } from "@/lib/supabase/admin";

// A project document's own bytes, for the page that draws it (the P&ID drawing
// comparison renders both PDFs in the browser).
//
// The bucket is private. This checks who is asking -- the same rule as the
// document's page: a member of the project's organization, and Document Control
// for anything but an ISO -- then passes the file through, so the browser reads it
// from this app's own address rather than from a storage link it could pass on.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const session = await getSessionUser();
  if (!session) return new NextResponse("Not signed in.", { status: 401 });

  const { id: projectId, docId } = await params;
  const notFound = () => new NextResponse("File not found.", { status: 404 });
  if (!UUID.test(projectId) || !UUID.test(docId)) return notFound();

  const db = getDb();
  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  // The same answer for "no such file" and "not yours", so ids cannot be probed.
  if (!document || document.projectId !== projectId) return notFound();
  const [project] = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || !(await canReadOrganization(session, project.organizationId))) return notFound();
  if (!session.isDcc && document.docType !== "iso") return notFound();

  const { data, error } = await createAdminClient().storage.from("documents").download(document.storagePath);
  if (error || !data) return new NextResponse("The file could not be retrieved.", { status: 502 });

  return new NextResponse(await data.arrayBuffer(), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${document.fileName.replace(/[^\w.\- ]+/g, "_")}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
