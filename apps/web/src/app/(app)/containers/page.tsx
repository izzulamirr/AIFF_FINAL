import Link from "next/link";
import { asc, eq, inArray } from "drizzle-orm";
import { documents, extractedTags, organizationMembers, projects } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { buildContainerSpools, type ContainerSpool } from "@/lib/containers";
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
  // Ordered by something that cannot change, so a bare /containers lands on
  // the same project every visit.
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
        <h1 className="text-xl font-semibold">Container check</h1>
        <p className="text-sm text-gray-500">
          No projects yet.{" "}
          <Link href="/projects" className="underline">
            Create one
          </Link>{" "}
          and upload an isometric to check its spools.
        </p>
      </div>
    );
  }

  const isoDocs = (
    await db.select().from(documents).where(eq(documents.projectId, projectId)).orderBy(asc(documents.uploadedAt), asc(documents.id))
  ).filter((d) => d.docType === "iso");

  const drawingId = params.drawing && isoDocs.some((d) => d.id === params.drawing) ? params.drawing : undefined;
  const sourceDocs = drawingId ? isoDocs.filter((d) => d.id === drawingId) : isoDocs;

  const perDoc: Array<{ id: string; fileName: string; spools: ContainerSpool[] }> = [];
  for (const doc of sourceDocs) {
    const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, doc.id));
    const spools = buildContainerSpools(
      tags.map((t) => ({ id: t.id, tagType: t.tagType, tagNumber: t.tagNumber, sourcePage: t.sourcePage, attributes: t.attributes }))
    );
    if (spools.length > 0) perDoc.push({ id: doc.id, fileName: doc.fileName, spools });
  }

  const totalSpools = perDoc.reduce((n, d) => n + d.spools.length, 0);
  const withFieldWelds = perDoc.reduce((n, d) => n + d.spools.filter((s) => s.fieldWelds > 0).length, 0);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Container check</h1>
      <SpoolingSelectors
        projects={myProjects.map((p) => ({
          id: p.id,
          label: myProjects.filter((o) => o.name === p.name).length > 1 ? `${p.name} (${p.id.slice(0, 8)})` : p.name,
        }))}
        projectId={projectId}
        drawings={isoDocs.map((d) => ({ id: d.id, label: d.fileName }))}
        drawingId={drawingId ?? ""}
        basePath="/containers"
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
          None of this project&rsquo;s isometrics have spools yet. Run the extraction from the{" "}
          <Link href={`/projects/${projectId}`} className="underline">
            project page
          </Link>
          , or see the{" "}
          <Link href={`/spooling?project=${projectId}`} className="underline">
            spooling page
          </Link>
          .
        </p>
      )}

      {perDoc.length > 0 && (
        <p className="text-sm">
          <span className="font-medium">{totalSpools}</span> spool{totalSpools === 1 ? "" : "s"} to ship
          {withFieldWelds > 0 && (
            <span className="text-amber-700">
              {" · "}
              {withFieldWelds} carr{withFieldWelds === 1 ? "ies" : "y"} a field weld, so ship 150mm longer
            </span>
          )}
          . Sizes are worked out from the dimensions printed on the drawing &mdash; check each one against the lengths shown beneath it.
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
          <ContainerFit spools={doc.spools} />
        </section>
      ))}
    </div>
  );
}
