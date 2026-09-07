import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { documents, extractedTags, extractionJobs, organizationMembers, projects } from "@easy/db";
import { outlineExtentMm, type CutPart, type CutShape } from "@easy/shared";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { MAX_UPLOAD_MB } from "@/lib/uploadLimits";
import { deleteDocument, uploadDocument } from "../projects/[id]/actions";
import { DeleteDocumentButton } from "../projects/[id]/DeleteDocumentButton";
import { loadCuttingQuantities, loadCuttingStock } from "./queries";
import { CuttingSelectors } from "./CuttingSelectors";
import { CuttingPlanner } from "./CuttingPlanner";

// Cutting plan.
//
// A cutting-plate drawing says what has to be cut and how big each piece is;
// it does not say what plate to buy or where on it anything goes. This page
// does that: it reads the parts off the drawing, then arranges them on stock
// plate with the cutting allowances that keep each piece the size it was
// drawn, using as few plates as the geometry allows.
//
// The arranging is arithmetic (@easy/shared's nestParts), not a model
// judgement -- the same parts and the same stock must always give the same
// layout, or nobody can check the plan or re-issue it.
export default async function CuttingPage({
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
  // Ordered, and ordered by something that cannot change. Postgres returns an
  // unordered select in whatever order it likes, and the fallback below is
  // "the first project" -- so an unordered list meant a bare /cutting could
  // land on a different project on every visit, and stock saved against one
  // project came back empty when the next render picked another. Creation
  // order is stable and is also the order a person expects their projects in.
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
        <h1 className="text-xl font-semibold">Cutting Plan</h1>
        <p className="text-gray-500">
          You need a project first --{" "}
          <Link href="/projects" className="underline">
            create one
          </Link>
          .
        </p>
      </div>
    );
  }

  const projectDocs = await db.select().from(documents).where(eq(documents.projectId, projectId));
  const cuttingDocs = projectDocs.filter((d) => d.docType === "cutting");

  const jobs = cuttingDocs.length
    ? await db
        .select()
        .from(extractionJobs)
        .where(inArray(extractionJobs.documentId, cuttingDocs.map((d) => d.id)))
    : [];
  const latestJob = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    const existing = latestJob.get(job.documentId);
    if (!existing || job.createdAt > existing.createdAt) latestJob.set(job.documentId, job);
  }

  async function handleUpload(formData: FormData) {
    "use server";
    formData.set("docType", "cutting");
    await uploadDocument(projectId!, formData);
  }

  // A job is cut from one stock of plate whatever it was drawn on, so every
  // cutting drawing in the project nests together by default; narrowing to a
  // single drawing only ever buys more plate, but is offered for the case
  // where one drawing is being issued to the shop on its own.
  const drawingId = params.drawing && cuttingDocs.some((d) => d.id === params.drawing) ? params.drawing : undefined;
  const sourceDocs = drawingId ? cuttingDocs.filter((d) => d.id === drawingId) : cuttingDocs;

  const partRows = sourceDocs.length
    ? await db
        .select()
        .from(extractedTags)
        .where(and(inArray(extractedTags.documentId, sourceDocs.map((d) => d.id)), eq(extractedTags.tagType, "cut_item")))
    : [];

  const parts: CutPart[] = partRows
    .map((row) => {
      const a = row.attributes as Record<string, unknown>;
      const numberOr = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
      const figures = Array.isArray(a.dimension_figures) ? (a.dimension_figures as unknown[]).map(String) : [];
      const rings = Array.isArray(a.outline_rings) ? (a.outline_rings as Array<Array<[number, number]>>) : null;
      // Where an outline exists it defines the box, not the other way round:
      // the two have to be in the same frame or the profile is drawn hanging
      // out of the rectangle reserved for it.
      const extent = rings ? outlineExtentMm(rings) : null;
      return {
        // The row id keeps two identically marked parts from different
        // drawings distinct, which the nest needs and the mark alone cannot
        // give.
        id: String(row.id),
        partNo: row.tagNumber,
        // The printed dimension figures ARE the description worth showing --
        // they are what a reviewer checks the cut size against.
        description: figures.length ? figures.join("  ") : null,
        shape: (a.shape as CutShape) ?? "profile",
        lengthMm: extent?.lengthMm ?? numberOr(a.length_mm) ?? 0,
        widthMm: extent?.widthMm ?? numberOr(a.width_mm) ?? 0,
        thicknessMm: numberOr(a.thickness_mm),
        material: typeof a.material === "string" && a.material.trim() ? a.material : null,
        quantity: numberOr(a.quantity) ?? 1,
        rotatable: a.rotatable !== false,
        // Present only where the parts were read from CAD. A part from a
        // plotted PDF has dimensions and no shape, and the difference is
        // visible on every drawing this produces.
        outlinePath: typeof a.outline_path === "string" ? a.outline_path : null,
        outlineRings: Array.isArray(a.outline_rings) ? (a.outline_rings as CutPart["outlineRings"]) : null,
        outlineRingInfo: Array.isArray(a.outline_ring_info) ? (a.outline_ring_info as CutPart["outlineRingInfo"]) : null,
        netAreaMm2: numberOr(a.net_area_mm2),
      } satisfies CutPart;
    })
    .sort((a, b) => b.lengthMm * b.widthMm - a.lengthMm * a.widthMm);

  // A project that holds both the plotted PDF and the CAD file of the same
  // drawing has every part twice: once with dimensions and no shape, once with
  // the real profile. Nesting both would cut everything twice. The CAD read
  // supersedes the PDF read of the same job, so where both exist the PDF parts
  // drop out -- and the page says so, because silently halving somebody's part
  // list is not something to do quietly. Picking a single drawing above
  // overrides this.
  const outlinedParts = parts.filter((p) => p.outlineRings?.length);
  const supersededParts = drawingId || outlinedParts.length === 0 ? 0 : parts.length - outlinedParts.length;
  const nestParts_ = supersededParts > 0 ? outlinedParts : parts;

  // The quantity to cut is a decision, not a measurement: the geometry only
  // reports how many times a shape was drawn. Where somebody has set a number
  // it wins outright, including zero, which means "not this run".
  const savedQuantities = await loadCuttingQuantities(projectId);
  const quantityByMark = new Map(savedQuantities.map((row) => [row.partMark, row.quantity]));
  const withQuantities = nestParts_.map((part) =>
    quantityByMark.has(part.partNo) ? { ...part, quantity: quantityByMark.get(part.partNo)! } : part
  );

  const savedStock = await loadCuttingStock(projectId);

  // The drawing usually names the plate it is all to be cut from ("PLATE SIZE :
  // PL 50mm X 3000mm X 12000mm"). Where it does, that is not a default to be
  // improved on -- it is the stock, and it seeds the planner so nobody retypes
  // what the drawing already says.
  const firstAttrs = (partRows[0]?.attributes ?? {}) as Record<string, unknown>;
  const asNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const drawingLength = asNum(firstAttrs.sheet_plate_length_mm);
  const drawingWidth = asNum(firstAttrs.sheet_plate_width_mm);
  const drawingThickness = asNum(firstAttrs.sheet_thickness_mm);
  const drawingStock =
    drawingLength && drawingWidth && drawingThickness
      ? {
          lengthMm: drawingLength,
          widthMm: drawingWidth,
          thicknessMm: drawingThickness,
          material: typeof firstAttrs.sheet_material === "string" ? firstAttrs.sheet_material : null,
          statedAs: typeof firstAttrs.sheet_plate_size === "string" ? firstAttrs.sheet_plate_size : null,
        }
      : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Cutting Plan</h1>
      <p className="max-w-3xl text-sm text-gray-600">
        A cutting-plate drawing says what has to be cut and how big each piece is; it does not say what plate to buy or where on it
        anything goes. This reads the parts off the drawing and arranges them on stock plate with the cutting allowances that keep each
        piece the size it was drawn &mdash; the kerf the torch burns away, plus a web of solid metal between cuts &mdash; on as few
        plates as the geometry allows.
      </p>

      <CuttingSelectors
        projects={myProjects.map((p) => ({
          id: p.id,
          // Project names are not unique across orgs, so a duplicated name is
          // qualified rather than left ambiguous.
          label: myProjects.filter((o) => o.name === p.name).length > 1 ? `${p.name} (${p.id.slice(0, 8)})` : p.name,
        }))}
        projectId={projectId}
        drawings={cuttingDocs.map((d) => ({ id: d.id, label: d.fileName }))}
        drawingId={drawingId ?? ""}
      />

      <div className="flex flex-wrap gap-4">
        <form action={handleUpload} className="flex max-w-md flex-col gap-2 rounded border p-4">
          <p className="text-sm font-medium">Upload cutting drawings</p>
          <p className="text-xs text-gray-500">
            <strong>Upload the DWG or DXF if you have it.</strong> A CAD file carries the part outlines as geometry, so the profiles are
            read exactly and the nest works to the real shape &mdash; and it is read by arithmetic, in seconds, with no model involved.
          </p>
          <p className="text-xs text-gray-500">
            A plotted <strong>PDF</strong> still works, but it records the dimension figures and not the geometry: the outlines arrive
            exploded into disconnected dash fragments mixed in with dimension lines, and nothing can reliably regroup them. From a PDF
            you get sizes and part marks, and every part is nested as its bounding box.
          </p>
          <label className="text-sm">
            PDF, DWG or DXF (max {MAX_UPLOAD_MB} MB)
            <input
              type="file"
              name="file"
              accept=".pdf,.dwg,.dxf,application/pdf,image/vnd.dwg,image/vnd.dxf"
              required
              className="mt-1 block w-full"
            />
          </label>
          <button className="rounded bg-black px-4 py-2 text-white">Upload</button>
        </form>

        <div className="min-w-[22rem] flex-1 rounded border p-4">
          <p className="mb-2 text-sm font-medium">Cutting drawings in this project</p>
          <table className="w-full text-left text-sm">
            <tbody>
              {cuttingDocs.map((doc) => {
                const job = latestJob.get(doc.id);
                return (
                  <tr key={doc.id} className="border-b">
                    <td className="py-1">{doc.fileName}</td>
                    <td className="text-gray-500">
                      {job?.status ?? "no job"}
                      {job?.status === "running" && job.progressTotal
                        ? ` ${job.progressCurrent ?? 0}/${job.progressTotal}`
                        : ""}
                      {job?.status === "failed" && job.errorMessage ? `: ${job.errorMessage.slice(0, 80)}` : ""}
                    </td>
                    <td className="py-1 text-right">
                      <DeleteDocumentButton
                        fileName={doc.fileName}
                        onDelete={async () => {
                          "use server";
                          await deleteDocument(projectId!, doc.id);
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
              {cuttingDocs.length === 0 && (
                <tr>
                  <td className="py-2 text-gray-500">None uploaded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
          {parts.length > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              {parts.length} part{parts.length === 1 ? "" : "s"} extracted,{" "}
              {parts.reduce((sum, p) => sum + p.quantity, 0)} piece
              {parts.reduce((sum, p) => sum + p.quantity, 0) === 1 ? "" : "s"} to cut.
            </p>
          )}
        </div>
      </div>

      {/* Keyed on the project so switching project rebuilds the planner from
          that project's stock. Without it the component keeps the state it
          was first mounted with, and the previous project's plate sizes stay
          on screen -- ready to be saved onto the project now selected. */}
      {supersededParts > 0 && (
        <p className="rounded border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900">
          This project holds both a CAD file and a plotted PDF of the cutting drawing. The CAD file carries the real outlines, so its{" "}
          <strong>{outlinedParts.length} part{outlinedParts.length === 1 ? "" : "s"}</strong> are what is nested below and the{" "}
          {supersededParts} part{supersededParts === 1 ? "" : "s"} read from the PDF are set aside &mdash; they are the same pieces
          measured a worse way, and nesting both would cut everything twice. Pick a single drawing above if that is not what you want.
        </p>
      )}

      <CuttingPlanner
        key={projectId}
        projectId={projectId}
        projectName={myProjects.find((p) => p.id === projectId)?.name ?? "project"}
        drawingId={drawingId ?? null}
        parts={withQuantities.filter((p) => p.quantity > 0)}
        drawnQuantities={Object.fromEntries(nestParts_.map((p) => [p.partNo, p.quantity]))}
        savedQuantities={Object.fromEntries(savedQuantities.map((r) => [r.partMark, r.quantity]))}
        drawingStock={drawingStock}
        initialStock={savedStock.map((row) => ({
          id: row.id,
          lengthMm: row.lengthMm,
          widthMm: row.widthMm,
          thicknessMm: row.thicknessMm,
          material: row.material,
          quantity: row.quantity,
        }))}
      />
    </div>
  );
}
