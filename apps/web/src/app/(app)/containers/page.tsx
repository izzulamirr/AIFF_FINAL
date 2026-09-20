import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { documents, extractedTags, projects } from "@easy/db";
import { getSessionUser } from "@/lib/session";
import { visibleOrganizations } from "@/lib/access";
import { findLine, isoLinesOf, lineKey } from "@/lib/isoLines";
import { getDb } from "@/lib/db";
import { buildContainerSpools, type ContainerSpool } from "@/lib/containers";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, Stat } from "@/components/ui/primitives";
import { IconFile, IconFolder } from "@/components/ui/icons";
import { SpoolingSelectors } from "../spooling/SpoolingSelectors";
import { ContainerFit } from "./ContainerFit";

// Container check.
//
// A spool is fabricated in the shop and has to reach site in a box. Whether it
// does is arithmetic, but three parts of it are easy to get wrong and each has
// cost a real shipment:
//
//   - a spool can be TURNED, and ANGLED. A 20ft is 5,898mm end to end but
//     6,350mm across the floor and 6,786mm corner to corner, so a 6m spool of
//     small section goes in -- swung round. Length alone decides nothing.
//   - it has to get THROUGH THE DOOR, which is smaller than the space behind
//     it, so a spool can fit the box and still not go in.
//   - a FIELD WELD ships with 150mm of excess pipe on it (NOTE 4), and that
//     is often what tips a borderline spool into the next size up.
//
// Its own page, for the same reason spooling is: it reads one drawing's own
// spools and needs nothing cross-document.
export default async function ContainersPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; line?: string; drawing?: string; [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const session = await getSessionUser();
  if (!session) return null;

  const db = getDb();
  // The organizations this person can read: Document Control's own, or every
  // one for a plain user (see lib/access.ts). This used to ask for the
  // person's membership rows directly, which is empty for a User -- so a User
  // opening this page was told there were no projects at all.
  const orgIds = (await visibleOrganizations(session)).map((o) => o.id);
  // Ordered by something that cannot change, so a bare /containers lands on
  // the same project every visit.
  const myProjects = orgIds.length
    ? await db
        .select()
        .from(projects)
        .where(inArray(projects.organizationId, orgIds))
        .orderBy(asc(projects.createdAt), asc(projects.id))
    : [];

  const requestedProject = params.project && myProjects.some((p) => p.id === params.project) ? params.project : undefined;
  // A plain user gets here from a project's own tiles, so the project is always
  // named in the URL and this page shows that project alone; without one they go
  // back to the start rather than land on a project they never chose. Document
  // Control arrives from the sidebar with none chosen, and gets the first plus
  // the picker. (Same rule as the spooling page.)
  if (!requestedProject && !session.isDcc) redirect("/organizations");
  const projectId = requestedProject ?? myProjects[0]?.id;
  if (!projectId) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Container check" />
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
            Create a project and upload an isometric to check its spools.
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

  const isoDocs = (
    await db.select().from(documents).where(eq(documents.projectId, projectId)).orderBy(asc(documents.uploadedAt), asc(documents.id))
  ).filter((d) => d.docType === "iso" && (!line || line.documentIds.includes(d.id)));

  const drawingId = params.drawing && isoDocs.some((d) => d.id === params.drawing) ? params.drawing : undefined;
  const sourceDocs = drawingId ? isoDocs.filter((d) => d.id === drawingId) : isoDocs;

  const perDoc: Array<{ id: string; fileName: string; spools: ContainerSpool[] }> = [];
  for (const doc of sourceDocs) {
    const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, doc.id));
    // A document can hold more than one line; keep only the chosen one's spools.
    const spools = buildContainerSpools(
      tags.map((t) => ({ id: t.id, tagType: t.tagType, tagNumber: t.tagNumber, sourcePage: t.sourcePage, attributes: t.attributes }))
    ).filter((s) => !line || lineKey(s.lineNumber) === line.key);
    if (spools.length > 0) perDoc.push({ id: doc.id, fileName: doc.fileName, spools });
  }

  const totalSpools = perDoc.reduce((n, d) => n + d.spools.length, 0);
  const withFieldWelds = perDoc.reduce((n, d) => n + d.spools.filter((s) => s.fieldWelds > 0).length, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Container check"
        back={
          line && !session.isDcc
            ? { href: `/projects/${projectId}?line=${encodeURIComponent(line.lineNumber)}`, label: line.lineNumber }
            : { href: `/projects/${projectId}`, label: myProjects.find((p) => p.id === projectId)?.name ?? "Project" }
        }
        description="Whether each spool fits a 20ft container: turned, angled and through the door, with 150mm of excess pipe for every field weld."
      />
      {/* A user with one drawing for the line has nothing to choose. */}
      {(session.isDcc || isoDocs.length > 1) && (
        <SpoolingSelectors
          projects={myProjects.map((p) => ({
            id: p.id,
            label: myProjects.filter((o) => o.name === p.name).length > 1 ? `${p.name} (${p.id.slice(0, 8)})` : p.name,
          }))}
          projectId={projectId}
          showProject={session.isDcc}
          line={line?.lineNumber}
          drawings={isoDocs.map((d) => ({ id: d.id, label: d.fileName }))}
          drawingId={drawingId ?? ""}
          basePath="/containers"
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
          <EmptyState icon={<IconFile />} title="No spools yet">
            {session.isDcc ? (
              <>
                None of this project&rsquo;s isometrics have spools yet. Run the extraction from the{" "}
                <Link href={`/projects/${projectId}`} className="link">
                  project page
                </Link>
                , or see the{" "}
                <Link href={`/spooling?project=${projectId}`} className="link">
                  spooling page
                </Link>
                .
              </>
            ) : (
              <>
                None of this project&rsquo;s isometrics have spools to show yet. If Document Control has just uploaded them, extraction
                may still be running &mdash; see{" "}
                <Link href={`/spooling?project=${projectId}`} className="link">
                  Spooling
                </Link>{" "}
                for the detail.
              </>
            )}
          </EmptyState>
        </div>
      )}

      {perDoc.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-4">
            <Stat label={totalSpools === 1 ? "Spool to ship" : "Spools to ship"} value={totalSpools} />
            {withFieldWelds > 0 && (
              <Stat
                label={`Carr${withFieldWelds === 1 ? "ies" : "y"} a field weld`}
                value={withFieldWelds}
                tone="warning"
                hint="ship 150mm longer"
              />
            )}
          </div>
          <p className="text-[0.8125rem] text-muted-foreground">
            Sizes are worked out from the dimensions printed on the drawing &mdash; check each one against the lengths shown beneath it.
          </p>
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
          <ContainerFit spools={doc.spools} />
        </section>
      ))}
    </div>
  );
}
