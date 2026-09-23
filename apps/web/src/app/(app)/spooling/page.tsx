import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { documents, extractedTags, projects } from "@easy/db";
import { getSessionUser } from "@/lib/session";
import { visibleOrganizations } from "@/lib/access";
import { findLine, isoLinesOf, lineKey } from "@/lib/isoLines";
import { getDb } from "@/lib/db";
import { buildSpoolSheets, spoolingTotals, type SpoolSheet } from "@/lib/spooling";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, Stat } from "@/components/ui/primitives";
import { IconFile, IconFolder } from "@/components/ui/icons";
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
  searchParams: Promise<{ project?: string; line?: string; drawing?: string; [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const session = await getSessionUser();
  if (!session) return null;

  const db = getDb();
  // The organizations this person can read: the ones they are a MEMBER of,
  // whoever they are (see lib/access.ts).
  const orgIds = (await visibleOrganizations(session)).map((o) => o.id);
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

  const requestedProject = params.project && myProjects.some((p) => p.id === params.project) ? params.project : undefined;
  // A plain user gets here from a project's own tiles (Organization -> Project
  // -> this page), so the project is always named in the URL and this page shows
  // that project alone. Without one there is nothing to show, and falling back
  // to "the first project" would put them somewhere they never chose -- so they
  // go back to the start. Document Control arrives from the sidebar with no
  // project chosen, and still gets the first one plus the picker.
  if (!requestedProject && !session.isDcc) redirect("/clients");
  const projectId = requestedProject ?? myProjects[0]?.id;
  if (!projectId) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Spooling" />
        <div className="card">
          <EmptyState
            icon={<IconFolder />}
            title="No projects yet"
            action={
              <Link href="/projects" className="btn btn-primary btn-sm mt-1">
                Create one
              </Link>
            }
          >
            Create a project and upload an isometric to see its spools.
          </EmptyState>
        </div>
      </div>
    );
  }

  // The ISO line this page is scoped to. A plain user reaches it from a line's
  // tools, so the line is always named; without a valid one they go back to the
  // project to choose it. Document Control can arrive with none and see every
  // line, as before.
  const line = params.line ? findLine(await isoLinesOf(projectId), params.line) : undefined;
  if (!line && !session.isDcc) redirect(`/projects/${projectId}`);

  // Ordered by upload time so the list is stable between renders, for the
  // same reason the project list is.
  const isoDocs = (
    await db.select().from(documents).where(eq(documents.projectId, projectId)).orderBy(asc(documents.uploadedAt), asc(documents.id))
  ).filter((d) => d.docType === "iso" && (!line || line.documentIds.includes(d.id)));

  const drawingId = params.drawing && isoDocs.some((d) => d.id === params.drawing) ? params.drawing : undefined;
  const sourceDocs = drawingId ? isoDocs.filter((d) => d.id === drawingId) : isoDocs;

  const perDoc: Array<{ id: string; fileName: string; sheets: SpoolSheet[] }> = [];
  for (const doc of sourceDocs) {
    const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, doc.id));
    // A document can hold more than one line; keep only the chosen one's sheets.
    const sheets = buildSpoolSheets(
      tags.map((t) => ({ id: t.id, tagType: t.tagType, tagNumber: t.tagNumber, sourcePage: t.sourcePage, attributes: t.attributes }))
    ).filter((s) => !line || lineKey(s.lineNumber) === line.key);
    if (sheets.length > 0) perDoc.push({ id: doc.id, fileName: doc.fileName, sheets });
  }

  const totals = spoolingTotals(perDoc.flatMap((d) => d.sheets));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Spooling"
        back={
          line && !session.isDcc
            ? { href: `/projects/${projectId}?line=${encodeURIComponent(line.lineNumber)}`, label: line.lineNumber }
            : { href: `/projects/${projectId}`, label: myProjects.find((p) => p.id === projectId)?.name ?? "Project" }
        }
        description="Which welds fall in which spool, read off each isometric's own spool schedule, bolted joints and weld list."
      />
      {/* A user with one drawing for the line has nothing to choose. */}
      {(session.isDcc || isoDocs.length > 1) && (
        <SpoolingSelectors
          projects={myProjects.map((p) => ({
            id: p.id,
            // Two projects can share a name; the id keeps them apart in the list.
            label: myProjects.filter((o) => o.name === p.name).length > 1 ? `${p.name} (${p.id.slice(0, 8)})` : p.name,
          }))}
          projectId={projectId}
          showProject={session.isDcc}
          line={line?.lineNumber}
          drawings={isoDocs.map((d) => ({ id: d.id, label: d.fileName }))}
          drawingId={drawingId ?? ""}
        />
      )}

      {isoDocs.length === 0 && (
        <div className="card">
          <EmptyState icon={<IconFile />} title="No isometrics in this project yet">
            {session.isDcc ? (
              <>
                Upload one from the{" "}
                <Link href={`/projects/${projectId}`} className="link">
                  project page
                </Link>
                .
              </>
            ) : (
              "Document Control has not uploaded any isometrics to this project yet."
            )}
          </EmptyState>
        </div>
      )}

      {isoDocs.length > 0 && perDoc.length === 0 && (
        <div className="card">
          <EmptyState icon={<IconFile />} title="No spool or weld data yet">
            {session.isDcc ? (
              <>
                None of this project&rsquo;s isometrics have spool or weld data yet. Run the extraction from the{" "}
                <Link href={`/projects/${projectId}`} className="link">
                  project page
                </Link>
                .
              </>
            ) : (
              "None of this project's isometrics have spool or weld data to show yet. If Document Control has just uploaded them, extraction may still be running."
            )}
          </EmptyState>
        </div>
      )}

      {perDoc.length > 0 && (
        // Counts only. Anything that needs attention is called out; a clean
        // sheet says nothing, because the per-weld column already does.
        <div className="flex flex-wrap gap-4">
          <Stat label="Spools" value={totals.spools} />
          <Stat label="Welds" value={totals.welds} />
          <Stat label={totals.sheets === 1 ? "Sheet" : "Sheets"} value={totals.sheets} />
          {totals.disagreeing > 0 && <Stat label="Mismatches against the drawing" value={totals.disagreeing} tone="warning" />}
          {totals.unassigned > 0 && <Stat label="Welds with no spool" value={totals.unassigned} tone="warning" />}
        </div>
      )}

      {perDoc.map((doc) => (
        <section key={doc.id} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="section-title break-all">{doc.fileName}</h2>
            <Link href={`/projects/${projectId}/documents/${doc.id}`} className="link text-[0.8125rem]">
              Open drawing
            </Link>
          </div>
          <SpoolSheets sheets={doc.sheets} />
        </section>
      ))}
    </div>
  );
}
