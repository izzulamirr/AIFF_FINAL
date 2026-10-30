import Link from "next/link";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { documents, extractedTags, organizationMembers, projects } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { buildSupportSheets, supportTotals, type SupportSheet } from "@/lib/supports";
import { SpoolingSelectors } from "../spooling/SpoolingSelectors";
import { SupportSheets } from "./SupportSheets";

// Pipe supports.
//
// The question is not "is there a support" but "is the pipe held up often
// enough", and that is a measurement against the project's span sheet: how
// far apart two supports sit, against how far apart they may sit for that
// size, schedule, material and shape of run.
//
// Its own page rather than a tab on the ISO document, and rather than the
// gate it used to be inside the cross-document compile. Support adequacy is
// read off ONE drawing -- the supports it calls for, the distances it prints,
// the pipe it is -- so nothing about it should wait for a P&ID, a line list
// or a GA to load, and a failure anywhere in that chain should not take the
// support check with it. It still reads the ISO's own extraction, which is
// where all of those inputs live.
export default async function SupportsPage({
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
  // Ordered by something that cannot change, for the same reason the spooling
  // page's list is: the fallback below is "the first project", so an
  // unordered select would land a bare /supports somewhere different each
  // visit.
  const myProjects = orgIds.length
    ? await db
        .select()
        .from(projects)
        .where(and(inArray(projects.organizationId, orgIds), isNull(projects.hiddenAt)))
        .orderBy(asc(projects.createdAt), asc(projects.id))
    : [];

  const projectId = params.project && myProjects.some((p) => p.id === params.project) ? params.project : myProjects[0]?.id;
  if (!projectId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Pipe Supports</h1>
        <p className="text-sm text-gray-500">
          No projects yet.{" "}
          <Link href="/projects" className="underline">
            Create one
          </Link>{" "}
          and upload an isometric to check its support spans.
        </p>
      </div>
    );
  }

  const isoDocs = (
    await db.select().from(documents).where(eq(documents.projectId, projectId)).orderBy(asc(documents.uploadedAt), asc(documents.id))
  ).filter((d) => d.docType === "iso");

  const drawingId = params.drawing && isoDocs.some((d) => d.id === params.drawing) ? params.drawing : undefined;
  const sourceDocs = drawingId ? isoDocs.filter((d) => d.id === drawingId) : isoDocs;

  const perDoc: Array<{ id: string; fileName: string; sheets: SupportSheet[] }> = [];
  for (const doc of sourceDocs) {
    const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, doc.id));
    const sheets = buildSupportSheets(
      tags.map((t) => ({ id: t.id, tagType: t.tagType, tagNumber: t.tagNumber, sourcePage: t.sourcePage, attributes: t.attributes }))
    );
    if (sheets.length > 0) perDoc.push({ id: doc.id, fileName: doc.fileName, sheets });
  }

  const totals = supportTotals(perDoc.flatMap((d) => d.sheets));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Pipe Supports</h1>
      <p className="max-w-3xl text-sm text-gray-600">
        A support span is not one figure per size. The project&apos;s span sheet draws the same pipe six ways &mdash; straight, turning
        an elbow, through a low V, carrying a branch tee, with a supported riser, and hanging a drop leg &mdash; and the permitted
        distance is different for each, because each puts a different weight between the same two supports. This checks every span
        against the case it actually is, and where a span is more than one case, the <strong>shortest</strong> governs.
      </p>

      <SpoolingSelectors
        projects={myProjects.map((p) => ({
          id: p.id,
          label: myProjects.filter((o) => o.name === p.name).length > 1 ? `${p.name} (${p.id.slice(0, 8)})` : p.name,
        }))}
        projectId={projectId}
        drawings={isoDocs.map((d) => ({ id: d.id, label: d.fileName }))}
        drawingId={drawingId ?? ""}
        basePath="/supports"
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
          None of this project&rsquo;s isometrics carry support data yet. Run the extraction from the{" "}
          <Link href={`/projects/${projectId}`} className="underline">
            project page
          </Link>
          .
        </p>
      )}

      {perDoc.length > 0 && (
        <p className="text-sm">
          <span className="font-medium">{totals.called}</span> supports called for, <span className="font-medium">{totals.supports}</span>{" "}
          located, <span className="font-medium">{totals.spans}</span> span{totals.spans === 1 ? "" : "s"} measured across {totals.sheets}{" "}
          sheet{totals.sheets === 1 ? "" : "s"}.
          {totals.over > 0 && <span className="text-red-600"> {totals.over} over the standard.</span>}
          {totals.unchecked > 0 && <span className="text-amber-700"> {totals.unchecked} could not be checked.</span>}
          {totals.unlocated > 0 && <span className="text-amber-700"> {totals.unlocated} support not located on a drawing.</span>}
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
          <SupportSheets sheets={doc.sheets} />
        </section>
      ))}
    </div>
  );
}
