import Link from "next/link";
import { asc, eq, inArray } from "drizzle-orm";
import { documents, extractedTags, organizationMembers, projects } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { buildSpoolSheets, spoolingTotals, type SpoolSheet } from "@/lib/spooling";
import { SpoolingSelectors } from "./SpoolingSelectors";
import { SpoolSheets } from "./SpoolSheets";

// Spooling.
//
// A spool is one shop-welded assembly: the piece that gets fabricated, stamped
// and shipped as a unit. Which welds fall in which spool is what a fabricator
// actually works from, and it is read off the ISOMETRIC -- the sheet's own
// PIPE SPOOLS schedule, the bolted joints along the run, and the field welds
// in its weld list.
//
// This is its own page rather than a tab on the ISO document because it is a
// different job. The ISO page compares one drawing against others -- design
// basis against the line list, routing and fittings against the P&ID -- and
// every one of those needs sibling documents loaded and matched. Spooling
// needs none of that: it reads one drawing on its own terms. Sharing a page
// meant the spool view only appeared once the whole cross-document compile had
// run, and a problem anywhere in that chain took the spool list with it.
export default async function SpoolingPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; drawing?: string; [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const db = getDb();
  const memberships = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, user.id));
  const orgIds = memberships.map((m) => m.organizationId);
  // Ordered by something that cannot change: an unordered select comes back in
  // whatever order Postgres likes, and the fallback here is "the first
  // project", so a bare /spooling would otherwise land somewhere different on
  // every visit.
  const myProjects = orgIds.length
    ? await db
        .select()
        .from(projects)
        .where(inArray(projects.organizationId, orgIds))
        .orderBy(asc(projects.createdAt), asc(projects.id))
    : [];

  const projectId = params.project && myProjects.some((p) => p.id === params.project) ? params.project : myProjects[0]?.id;
  if (!projectId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Spooling</h1>
        <p className="text-sm text-gray-500">
          No projects yet. <Link href="/projects" className="underline">Create one</Link> and upload an isometric to see its spools.
        </p>
      </div>
    );
  }

  // Ordered by upload time so the list is stable between renders, for the
  // same reason the project list is.
  const isoDocs = (
    await db.select().from(documents).where(eq(documents.projectId, projectId)).orderBy(asc(documents.uploadedAt), asc(documents.id))
  ).filter((d) => d.docType === "iso");

  const drawingId = params.drawing && isoDocs.some((d) => d.id === params.drawing) ? params.drawing : undefined;
  const sourceDocs = drawingId ? isoDocs.filter((d) => d.id === drawingId) : isoDocs;

  const perDoc: Array<{ id: string; fileName: string; sheets: SpoolSheet[] }> = [];
  for (const doc of sourceDocs) {
    const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, doc.id));
    const sheets = buildSpoolSheets(
      tags.map((t) => ({ id: t.id, tagType: t.tagType, tagNumber: t.tagNumber, sourcePage: t.sourcePage, attributes: t.attributes }))
    );
    if (sheets.length > 0) perDoc.push({ id: doc.id, fileName: doc.fileName, sheets });
  }

  const totals = spoolingTotals(perDoc.flatMap((d) => d.sheets));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Spooling</h1>
      <SpoolingSelectors
        projects={myProjects.map((p) => ({
          id: p.id,
          // Two projects can share a name; the id keeps them apart in the list.
          label: myProjects.filter((o) => o.name === p.name).length > 1 ? `${p.name} (${p.id.slice(0, 8)})` : p.name,
        }))}
        projectId={projectId}
        drawings={isoDocs.map((d) => ({ id: d.id, label: d.fileName }))}
        drawingId={drawingId ?? ""}
      />

      {isoDocs.length === 0 && (
        <p className="text-sm text-gray-500">
          No isometrics in this project yet. Upload one from the{" "}
          <Link href={`/projects/${projectId}`} className="underline">
            project page
          </Link>
          .
        </p>
      )}

      {isoDocs.length > 0 && perDoc.length === 0 && (
        <p className="text-sm text-gray-500">
          None of this project&rsquo;s isometrics have spool or weld data yet. Run the extraction from the{" "}
          <Link href={`/projects/${projectId}`} className="underline">
            project page
          </Link>
          .
        </p>
      )}

      {perDoc.length > 0 && (
        // Counts only. Anything that needs attention is called out; a clean
        // sheet says nothing, because the per-weld column already does.
        <p className="text-sm">
          <span className="font-medium">{totals.spools}</span> spools and <span className="font-medium">{totals.welds}</span> welds across{" "}
          {totals.sheets} sheet{totals.sheets === 1 ? "" : "s"}.
          {totals.disagreeing > 0 && (
            <span className="text-amber-700">
              {" "}
              {totals.disagreeing} mismatch{totals.disagreeing === 1 ? "" : "es"} against the drawing.
            </span>
          )}
          {totals.unassigned > 0 && <span className="text-amber-700"> {totals.unassigned} with no spool.</span>}
        </p>
      )}

      {perDoc.map((doc) => (
        <section key={doc.id}>
          <h2 className="mb-2 font-medium">
            {doc.fileName}{" "}
            <Link href={`/projects/${projectId}/documents/${doc.id}`} className="text-sm font-normal text-gray-500 underline">
              open drawing
            </Link>
          </h2>
          <SpoolSheets sheets={doc.sheets} />
        </section>
      ))}
    </div>
  );
}
