import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { documents, extractionResults, extractedTags, projects } from "@easy/db";
import { normalizeTagNumber } from "@easy/shared";
import { getDb } from "@/lib/db";
import { canReadOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { buildIsoChecks } from "@/lib/isoChecks";
import type { ValveMatchGroup } from "@/lib/verifyIso";
import { PageHeader } from "@/components/ui/PageHeader";
import { BomSheets, DesignBasisTable, FittingsMatchGroups, RoutingTable } from "@/components/checks/IsoCheckTables";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { IconFile } from "@/components/ui/icons";
import { ExtractedTagsTable, type TagGroup } from "./ExtractedTagsTable";

const DOC_TYPE_LABELS: Record<string, string> = {
  pid: "P&ID",
  hmb: "H&MB",
  pfd: "PFD",
  spec_sheet: "Spec Sheet",
  iso: "ISO",
  ga: "GA",
  pll: "Line List (PLL)",
  pid_legend: "P&ID Legend",
};


export default async function DocumentDetailPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id: projectId, docId } = await params;
  const db = getDb();

  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!document || document.projectId !== projectId) return <p>Document not found.</p>;

  const session = await getSessionUser();
  if (!session) return null;

  // An account reads the organizations it is a member of and no others, and this
  // page is reached by a typed URL as easily as by a link -- so the check is here
  // and not only on the list that led to it. "Not found" either way: whose
  // drawing this is is not something to tell somebody who may not see it.
  const [project] = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || !(await canReadOrganization(session, project.organizationId))) return <p>Document not found.</p>;

  // A plain user sees ISO documents only. Nothing links them to any other kind,
  // but a document's URL is guessable, so the page refuses it as well.
  if (!session.isDcc && document.docType !== "iso") redirect(`/projects/${projectId}`);

  const [result] = await db
    .select()
    .from(extractionResults)
    .where(eq(extractionResults.documentId, docId))
    .orderBy(desc(extractionResults.createdAt))
    .limit(1);

  const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, docId));

  // Nest assembly accessories under their primary device: an instrument
  // carrying a parent_valve (valve-actuator accessories: positioner, ZI/ZIT,
  // limit switches, solenoid, handswitch) or a parent_instrument (e.g. a TT
  // installed in a TW thermowell -- the TW is always the primary) is a
  // subset of that primary and is rendered indented beneath it, not as a
  // flat top-level row. Docs with no parent links (every non-P&ID type)
  // fall through to the original flat listing unchanged.
  const tagByNorm = new Map(tags.map((t) => [normalizeTagNumber(t.tagNumber), t] as const));
  const accessoriesByParent = new Map<number, typeof tags>();
  const accessoryIds = new Set<number>();
  for (const t of tags) {
    const attrs = t.attributes as Record<string, unknown>;
    const parent = [attrs.parent_valve, attrs.parent_instrument].find((p): p is string => typeof p === "string" && p.trim().length > 0);
    if (!parent) continue;
    const parentTag = tagByNorm.get(normalizeTagNumber(parent));
    if (!parentTag || parentTag.id === t.id) continue; // orphan link stays top-level
    const list = accessoriesByParent.get(parentTag.id) ?? [];
    list.push(t);
    accessoriesByParent.set(parentTag.id, list);
    accessoryIds.add(t.id);
  }
  const topLevelTags = tags.filter((t) => !accessoryIds.has(t.id));
  const toRow = (t: (typeof tags)[number]) => ({ id: t.id, tagType: t.tagType, tagNumber: t.tagNumber, sourcePage: t.sourcePage, attributes: t.attributes });
  const tagGroups: TagGroup[] = topLevelTags.map((t) => ({ tag: toRow(t), accessories: (accessoriesByParent.get(t.id) ?? []).map(toRow) }));

  const isIso = document.docType === "iso";
  // The ISO's cross-document checks -- design basis against the PLL, routing and
  // fittings against the P&IDs, and the BOM by spec -- are in lib/isoChecks.ts,
  // shared with a line's summary so the two cannot disagree.
  const { designBasis, routingFittings, bomBySpec } = isIso
    ? await buildIsoChecks({ projectId, docId, document, tags })
    : { designBasis: [], routingFittings: [], bomBySpec: [] };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={<span className="break-all">{document.fileName}</span>}
        back={{ href: `/projects/${projectId}`, label: "Back to project" }}
        meta={
          <>
            <Badge>{DOC_TYPE_LABELS[document.docType] ?? document.docType}</Badge>
            <Badge>{document.pageCount ?? "?"} pages</Badge>
          </>
        }
      />

      {isIso && (
        <section className="card card-flush">
          <div className="card-header">
            <div>
              <h2 className="card-title">ISO checks</h2>
              <p className="card-description">This drawing compared against the project&apos;s other documents.</p>
            </div>
          </div>

          <div className="flex flex-col gap-10 p-5">
            <div>
              <h3 id="design-basis" className="section-title mb-3 scroll-mt-6">
                Design basis: ISO vs PLL
              </h3>
              {designBasis.length === 0 && <p className="text-sm text-muted-foreground">No PLL uploaded/extracted in this project yet.</p>}
              {designBasis.map(({ lineNumber, pllDocName, rows }) => (
                <div key={lineNumber} className="mb-5 last:mb-0">
                  <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                    <span>Line</span>
                    <span className="font-mono font-medium">{lineNumber}</span>
                    {rows ? (
                      <span className="text-muted-foreground">vs {pllDocName ?? "PLL"}</span>
                    ) : (
                      <Badge tone="danger">Not found in the PLL</Badge>
                    )}
                  </p>
                  {rows && <DesignBasisTable rows={rows} />}
                </div>
              ))}
            </div>

            <div>
              <h3 id="routing-fittings" className="section-title mb-3 scroll-mt-6">
                Routing &amp; fittings: ISO vs P&amp;ID
              </h3>
              {routingFittings.length === 0 && <p className="text-sm text-muted-foreground">No P&amp;ID uploaded/extracted in this project yet.</p>}
              {routingFittings.map(({ lineNumber, pidDocNames, rows }) => (
                <div key={lineNumber} className="mb-5 last:mb-0">
                  <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                    <span>Line</span>
                    <span className="font-mono font-medium">{lineNumber}</span>
                    {rows ? (
                      <span className="text-muted-foreground">vs {pidDocNames.join(", ")}</span>
                    ) : (
                      <Badge tone="danger">Not found on any P&amp;ID</Badge>
                    )}
                  </p>
                  {rows && <RoutingTable rows={rows} />}
                </div>
              ))}
            </div>

            {routingFittings.some((r) => r.valveMatch && r.valveMatch.length > 0) && (
              <div>
                <h3 id="fittings-match" className="section-title mb-3 scroll-mt-6">
                  Fittings match: ISO vs P&amp;ID
                </h3>
                <p className="callout mb-5 max-w-4xl">
                  Every in-line component both documents show: valves, flanges (by type &mdash; a weld neck, a blind and an orifice
                  flange are not interchangeable), spectacle blinds, reducers and instruments (named from their ISA tag, so FT-0003
                  is a flow transmitter and PI-0004 a pressure indicator). Paired on component type and nominal size, since the ISO
                  BOM aggregates by quantity and most P&amp;ID components are untagged, so neither side can be matched by tag. Left
                  out as not comparable: butt-weld fittings a P&amp;ID does not itemise (elbows, tees, olets), consumables (gaskets,
                  bolts), and instrument-loop accessories &mdash; only the primary device of a loop is a physical in-line item, so an
                  indicator reading from a transmitter is not counted again. Disagreements are listed first.
                </p>
                {routingFittings
                  .filter((r): r is typeof r & { valveMatch: ValveMatchGroup[] } => Boolean(r.valveMatch?.length))
                  .map(({ lineNumber, valveMatch: groups }) => (
                    <div key={lineNumber} className="mb-6 last:mb-0">
                      <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                        <span>Line</span>
                        <span className="font-mono font-medium">{lineNumber}</span>
                        <span className="text-muted-foreground">
                          {groups.length > 1 ? `${groups.length} material classes along the run` : "single material class"}
                        </span>
                      </p>
                      <FittingsMatchGroups groups={groups} />
                    </div>
                  ))}
              </div>
            )}

            {bomBySpec.length > 0 && (
              <div>
                <h3 id="bom-by-spec" className="section-title mb-3 scroll-mt-6">
                  BOM by spec, per sheet
                </h3>
                <BomSheets sheets={bomBySpec} />
              </div>
            )}
          </div>
        </section>
      )}

      {!result && (
        <div className="card">
          <EmptyState icon={<IconFile />} title="No extraction result yet for this document" />
        </div>
      )}

      {result && (
        <>
          <section className="card card-flush">
            <div className="card-header">
              <h2 className="card-title">
                Extracted tags <span className="font-normal text-muted-foreground">({tags.length})</span>
              </h2>
            </div>
            <ExtractedTagsTable groups={tagGroups} />
          </section>

          <section className="card card-flush">
            <div className="card-header">
              <h2 className="card-title">Raw extraction result</h2>
              <Badge mono>{result.schemaVersion}</Badge>
            </div>
            <pre className="code-block max-h-[600px] rounded-none border-0">{JSON.stringify(result.rawJson, null, 2)}</pre>
          </section>
        </>
      )}
    </div>
  );
}
