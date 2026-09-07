import Link from "next/link";
import { desc, eq, inArray, and } from "drizzle-orm";
import { documents, extractionJobs, extractionResults, extractedTags } from "@easy/db";
import { normalizeTagNumber, enrichIsoLineAttrs } from "@easy/shared";
import { getDb } from "@/lib/db";
import {
  buildDesignBasisComparison,
  buildRoutingFittingComparison,
  buildValveMatch,
  countImpliedIsolationValves,
  type ValveMatchGroup,
  countPidValves,
  isoSpecClasses,
  matchesLineAcrossSpecBreak,
  mergeIsoLineSheets,
  type DesignBasisRow,
  type RoutingFittingRow,
} from "@/lib/verifyIso";
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
  let pllOptions: (typeof documents.$inferSelect)[] = [];
  let pidOptions: (typeof documents.$inferSelect)[] = [];
  let docNameById = new Map<string, string>();
  // One entry per ISO line: its design-basis comparison against the PLL
  // (or null when the line isn't in the PLL / no PLL is uploaded yet).
  let designBasis: Array<{ lineNumber: string; pllDocName: string | null; rows: DesignBasisRow[] | null }> = [];
  // One entry per ISO line: routing + fitting count vs the project's P&IDs
  // (rows null when the line isn't found on any P&ID / none uploaded yet).
  let routingFittings: Array<{
    lineNumber: string;
    pidDocNames: string[];
    rows: RoutingFittingRow[] | null;
    valveMatch?: ValveMatchGroup[];
  }> = [];
  // BOM grouped by the class that governs each item, one block per SHEET --
  // a multi-sheet drawing carries a separate BOM per sheet and a spec break
  // ("MATL <class>" callouts either side of a joint) applies to the sheet
  // that draws it, so QC is done sheet by sheet.
  let bomBySpec: Array<{
    lineNumber: string;
    sheetLabel: string;
    page: number | null;
    breaks: Array<{ spec_class: string; rating?: string | number | null; location_note?: string }>;
    groups: Array<{
      specClass: string;
      items: Array<{ id: number; itemNo: string; description: string; itemCode: string; qty: string; basis: string }>;
    }>;
  }> = [];

  if (isIso) {
    const siblingDocs = await db
      .select()
      .from(documents)
      .where(eq(documents.projectId, projectId));

    const siblingJobs = await db
      .select({ job: extractionJobs })
      .from(extractionJobs)
      .innerJoin(documents, eq(documents.id, extractionJobs.documentId))
      .where(eq(documents.projectId, projectId));
    // Keep the NEWEST job per document, by timestamp. A document accumulates
    // one job row per attempt, and the query has no ORDER BY, so "the first
    // row seen" is whatever order Postgres happens to return -- which for a
    // document that failed a few times before succeeding is usually a failed
    // one. That made a successfully extracted P&ID vanish from this page's
    // dropdowns while the project listing (which does compare timestamps)
    // showed it as succeeded.
    const latestJobByDoc = new Map<string, (typeof siblingJobs)[number]["job"]>();
    for (const { job } of siblingJobs) {
      const existing = latestJobByDoc.get(job.documentId);
      if (!existing || job.createdAt > existing.createdAt) latestJobByDoc.set(job.documentId, job);
    }
    const latestStatusByDoc = new Map([...latestJobByDoc].map(([docId2, job]) => [docId2, job.status] as const));

    const succeeded = siblingDocs.filter((d) => d.id !== docId && latestStatusByDoc.get(d.id) === "succeeded");
    pllOptions = succeeded.filter((d) => d.docType === "pll");
    pidOptions = succeeded.filter((d) => d.docType === "pid");

    docNameById = new Map(siblingDocs.map((d) => [d.id, d.fileName]));
    docNameById.set(document.id, document.fileName);


    // Design-basis comparison, ISO title block vs the PLL row for the same
    // line number -- rendered for every ISO line whether or not a check has
    // been run, so the side-by-side view is always current.
    const isoLineTagsAll = tags.filter((t) => t.tagType === "line");
    // One line tag per sheet on a multi-sheet drawing -- collapse to one per
    // line so the comparison tables aren't repeated per sheet. The merge takes
    // the run's start from the first sheet and its end from the last (see
    // mergeIsoLineSheets); per-sheet tags stay available via sourcePage.
    const isoLineTags = mergeIsoLineSheets(isoLineTagsAll);
    if (pllOptions.length > 0 && isoLineTags.length > 0) {
      const pllTags = await db
        .select()
        .from(extractedTags)
        .where(and(inArray(extractedTags.documentId, pllOptions.map((d) => d.id)), eq(extractedTags.tagType, "line")));
      const pllByNorm = new Map(pllTags.map((t) => [t.tagNumberNormalized, t] as const));

      designBasis = isoLineTags.map((line) => {
        const pll = pllByNorm.get(normalizeTagNumber(line.tagNumber));
        // Same enrichment the gate chain applies: title-block blanks and
        // "XX.XX" placeholders are filled from the line-number decode.
        const isoAttrs = enrichIsoLineAttrs(line.tagNumber, line.attributes as Record<string, unknown>);
        return {
          lineNumber: line.tagNumber,
          pllDocName: pll ? docNameById.get(pll.documentId) ?? null : null,
          rows: pll ? buildDesignBasisComparison(isoAttrs, pll.attributes as Record<string, unknown>) : null,
        };
      });
    }

    // One block per sheet, in sheet order -- including sheets with no break,
    // whose rows all sit under the title-block class. Only the "Unassigned"
    // group means the drawing didn't show which side a row is on.
    bomBySpec = [...isoLineTagsAll]
      .sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0))
      .map((line) => {
        const lineAttrs = line.attributes as Record<string, unknown>;
        const breaks = (Array.isArray(lineAttrs.spec_breaks) ? lineAttrs.spec_breaks : []) as Array<{
          spec_class: string;
          rating?: string | number | null;
          location_note?: string;
        }>;
        const lineClass = typeof lineAttrs.spec_class === "string" ? lineAttrs.spec_class : "";

        const norm = normalizeTagNumber(line.tagNumber);
        const items = tags.filter((t) => {
          if (t.tagType !== "bom_item") return false;
          // Scope to this sheet so each sheet's BOM is reviewed on its own.
          if (line.sourcePage != null && t.sourcePage !== line.sourcePage) return false;
          const ln = (t.attributes as Record<string, unknown>).line_number;
          return typeof ln === "string" && normalizeTagNumber(ln) === norm;
        });
        if (items.length === 0) return null;

        const byClass = new Map<string, Array<{ id: number; itemNo: string; description: string; itemCode: string; qty: string; basis: string }>>();
        for (const item of items) {
          const a = item.attributes as Record<string, unknown>;
          // With no break on this sheet the title-block class governs every
          // row, so an unset class there is not an open question.
          const own =
            typeof a.item_spec_class === "string" && a.item_spec_class.trim()
              ? a.item_spec_class
              : breaks.length < 2 && lineClass
                ? lineClass
                : "Unassigned";
          const list = byClass.get(own) ?? [];
          list.push({
            id: item.id,
            // The PT NO as printed, and nothing else. Rows added by a
            // revision carry no PT NO, so this stays blank for them -- the
            // tag number is an internal key and must not leak into the
            // column.
            itemNo: typeof a.item_no === "string" ? a.item_no.trim() : "",
            description: String(a.description ?? ""),
            itemCode: String(a.item_code ?? "-"),
            qty: String(a.quantity ?? "-"),
            basis: typeof a.item_spec_basis === "string" ? a.item_spec_basis : breaks.length < 2 ? "sheet has no spec break" : "",
          });
          byClass.set(own, list);
        }
        const order = [...(breaks.length > 1 ? breaks.map((b) => b.spec_class) : [lineClass]), "Unassigned"];
        const groups = [...byClass.entries()]
          .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
          // Printed order, not numeric order: the sheet's two materials
          // blocks each restart their PT NO at 1, and the un-numbered added
          // rows sit under the category they belong to. Extraction records
          // rows top to bottom, so id order IS the order on the drawing --
          // sorting by number would interleave the blocks and float every
          // blank row to the top.
          .map(([specClass, groupItems]) => ({ specClass, items: groupItems.sort((x, y) => x.id - y.id) }));
        const sheetLabel = typeof lineAttrs.sheet === "string" && lineAttrs.sheet ? lineAttrs.sheet : line.sourcePage != null ? `page ${line.sourcePage}` : "";
        return { lineNumber: line.tagNumber, sheetLabel, page: line.sourcePage, breaks, groups };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    // Routing & fitting count, ISO vs the project's P&IDs -- same always-on
    // pattern as design basis, aggregated across every extracted P&ID (a
    // line legitimately spans several sheets/documents).
    if (pidOptions.length > 0 && isoLineTags.length > 0) {
      const pidTags = await db
        .select()
        .from(extractedTags)
        .where(and(inArray(extractedTags.documentId, pidOptions.map((d) => d.id)), inArray(extractedTags.tagType, ["line", "valve", "fitting", "instrument"])));
      const isoBomTags = tags.filter((t) => t.tagType === "bom_item");

      // The legend's "P&ID REPRESENTATION vs DETAILS" typicals, scoped to
      // this project's newest legend so a duplicate upload cannot
      // double-count. They are what turns an instrument bubble back into the
      // root valves, thermowell and orifice assembly the P&ID does not draw.
      const legendItems = await db
        .select()
        .from(extractedTags)
        .where(and(eq(extractedTags.projectId, projectId), eq(extractedTags.tagType, "legend_item")));
      const legendDocIds = [...new Set(legendItems.map((t) => t.documentId))];
      let scopedLegend = legendItems;
      if (legendDocIds.length > 1) {
        const [newest] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(inArray(documents.id, legendDocIds))
          .orderBy(desc(documents.uploadedAt))
          .limit(1);
        if (newest) scopedLegend = legendItems.filter((t) => t.documentId === newest.id);
      }
      const legendTypicalsFor = (instrumentTag: string) => {
        const prefix = (instrumentTag.trim().toUpperCase().match(/^[A-Z]+/) ?? [])[0];
        if (!prefix) return [];
        return scopedLegend.filter((t) => {
          const a = t.attributes as Record<string, unknown>;
          if (typeof a.implied_components !== "string" || !a.implied_components.trim()) return false;
          return String(a.applies_to ?? "")
            .toUpperCase()
            .split(/[/,]/)
            .map((s) => s.trim())
            .includes(prefix);
        });
      };

      routingFittings = isoLineTags.map((line) => {
        const norm = line.tagNumberNormalized;
        const pidLineMatches = pidTags.filter((t) => t.tagType === "line" && t.tagNumberNormalized === norm);
        if (pidLineMatches.length === 0) return { lineNumber: line.tagNumber, pidDocNames: [], rows: null };

        const pidLineAttrs = pidLineMatches.map((t) => t.attributes as Record<string, unknown>);
        const isoAttrsForSpec = enrichIsoLineAttrs(line.tagNumber, line.attributes as Record<string, unknown>);
        const specClasses = isoSpecClasses(isoAttrsForSpec);
        // Valves are matched across the spec break: past the break the run
        // carries a different line number, and those valves are still part of
        // this ISO drawing.
        const pidLineValveAttrs = pidTags
          .filter((t) => t.tagType === "valve" && matchesLineAcrossSpecBreak((t.attributes as Record<string, unknown>).line_number, line.tagNumber, specClasses))
          .map((t) => t.attributes as Record<string, unknown>);
        const pidValveCount = countPidValves(pidLineValveAttrs);
        const bomForLine = isoBomTags
          .filter((b) => {
            const ln = (b.attributes as Record<string, unknown>).line_number;
            return typeof ln === "string" && normalizeTagNumber(ln) === norm;
          })
          .map((b) => b.attributes as Record<string, unknown>);
        const pidLineFittings = pidTags
          .filter((t) => t.tagType === "fitting" && matchesLineAcrossSpecBreak((t.attributes as Record<string, unknown>).line_number, line.tagNumber, specClasses))
          .map((t) => t.attributes as Record<string, unknown>);
        // Instruments reference their line through line_or_equipment_ref
        // rather than line_number -- they sit on a tapping point, not in the
        // run itself.
        const pidLineInstruments = pidTags
          .filter((t) => {
            const attrs = t.attributes as Record<string, unknown>;
            return t.tagType === "instrument" && matchesLineAcrossSpecBreak(attrs.line_or_equipment_ref ?? attrs.line_number, line.tagNumber, specClasses);
          })
          // An instrument's ISA tag lives in the tag_number COLUMN, not in
          // its attributes, so mapping to attributes alone dropped the one
          // identifier the ISO and the P&ID both print for the same device
          // -- every instrument reached the match as "untagged". Valves and
          // fittings are deliberately NOT given the same treatment: their
          // column holds a descriptive fallback ("gate valve") for the
          // untagged symbols a P&ID is mostly made of, which is not a tag.
          .map((t): Record<string, unknown> => ({ ...(t.attributes as Record<string, unknown>), tag_number: t.tagNumber }));
        // Expand each PRIMARY instrument through its legend typical. Loop
        // accessories (an indicator reading from a transmitter) hang off the
        // same tapping and imply no further root valves of their own.
        const impliedValves = pidLineInstruments
          .filter((i) => !i.parent_instrument && !i.parent_valve)
          .flatMap((i) => {
            const tag = String(i.tag_number ?? "").trim();
            const candidates = tag ? legendTypicalsFor(tag) : [];
            if (candidates.length === 0) return [];
            const counts = candidates.map((t) => countImpliedIsolationValves((t.attributes as Record<string, unknown>).implied_components));
            // Several typicals claim one instrument letter because each
            // describes a DIFFERENT PART of the same hidden assembly, not a
            // competing answer: a TT has thermowell typicals covering how
            // the element is mounted and a separate one covering the
            // isolation valve at its tapping. A typical that never mentions
            // a valve is silent about valves -- it does not assert there are
            // none -- so the count is the largest any typical declares, not
            // one they must all agree on. Requiring agreement dropped the
            // root valve on every thermowell-mounted transmitter.
            const count = Math.max(...counts);
            return count > 0 ? [{ instrumentTag: tag, typicalName: candidates.map((t) => t.tagNumber).join(" / "), count }] : [];
          });
        const isoAttrs = isoAttrsForSpec;
        const pidDocNames = Array.from(new Set(pidLineMatches.map((t) => docNameById.get(t.documentId) ?? t.documentId)));
        return {
          lineNumber: line.tagNumber,
          pidDocNames,
          rows: buildRoutingFittingComparison(isoAttrs, bomForLine, pidLineAttrs, pidValveCount, pidLineFittings),
          valveMatch: buildValveMatch(bomForLine, pidLineValveAttrs, pidLineFittings, pidLineInstruments, impliedValves),
        };
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/projects/${projectId}`} className="text-sm text-blue-600 underline">
          &larr; Back to project
        </Link>
        <h1 className="text-xl font-semibold">{document.fileName}</h1>
        <p className="text-sm text-gray-500">
          {DOC_TYPE_LABELS[document.docType] ?? document.docType} &middot; {document.pageCount ?? "?"} pages
        </p>
      </div>

      {isIso && (
        <section className="rounded border p-4">
          <h2 className="mb-2 font-medium">ISO checks</h2>

          <h3 className="mb-2 mt-4 font-medium">Design basis: ISO vs PLL</h3>
          {designBasis.length === 0 && <p className="mb-4 text-sm text-gray-500">No PLL uploaded/extracted in this project yet.</p>}
          {designBasis.map(({ lineNumber, pllDocName, rows }) => (
            <div key={lineNumber} className="mb-4">
              <p className="mb-1 text-sm">
                Line <span className="font-mono">{lineNumber}</span>{" "}
                {rows ? <span className="text-gray-500">vs {pllDocName ?? "PLL"}</span> : <span className="text-red-600">-- not found in the PLL</span>}
              </p>
              {rows && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="py-1">Field</th>
                      <th>ISO</th>
                      <th>PLL</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.field} className="border-b">
                        <td className="py-1">{row.field}</td>
                        <td>{row.isoValue ?? "-"}</td>
                        <td>{row.pllValue ?? "-"}</td>
                        <td className={row.status === "match" ? "text-green-600" : row.status === "mismatch" ? "text-red-600" : "text-gray-400"}>
                          {row.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          <h3 className="mb-2 mt-4 font-medium">Routing &amp; fittings: ISO vs P&amp;ID</h3>
          {routingFittings.length === 0 && <p className="mb-4 text-sm text-gray-500">No P&amp;ID uploaded/extracted in this project yet.</p>}
          {routingFittings.map(({ lineNumber, pidDocNames, rows }) => (
            <div key={lineNumber} className="mb-4">
              <p className="mb-1 text-sm">
                Line <span className="font-mono">{lineNumber}</span>{" "}
                {rows ? <span className="text-gray-500">vs {pidDocNames.join(", ")}</span> : <span className="text-red-600">-- not found on any P&amp;ID</span>}
              </p>
              {rows && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="py-1">Item</th>
                      <th>ISO</th>
                      <th>P&amp;ID</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.field} className="border-b">
                        <td className="py-1">{row.field}</td>
                        <td>{row.isoValue ?? "-"}</td>
                        <td>{row.pidValue ?? "-"}</td>
                        <td
                          className={
                            row.status === "match"
                              ? "text-green-600"
                              : row.status === "mismatch"
                                ? "text-red-600"
                                : "text-gray-400"
                          }
                        >
                          {row.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          {routingFittings.some((r) => r.valveMatch && r.valveMatch.length > 0) && (
            <>
              <h3 className="mb-2 mt-4 font-medium">Fittings match: ISO vs P&amp;ID</h3>
              <p className="mb-2 text-xs text-gray-500">
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
                  <div key={lineNumber} className="mb-4">
                    <p className="mb-2 text-sm">
                      Line <span className="font-mono">{lineNumber}</span>
                      <span className="ml-2 text-gray-500">
                        {groups.length > 1 ? `${groups.length} material classes along the run` : "single material class"}
                      </span>
                    </p>
                    {groups.map((group) => (
                      <div
                        key={group.specClass}
                        className={`mb-4 rounded border p-3 ${group.specClass === "unassigned" ? "border-amber-500" : ""}`}
                      >
                        <p className="mb-2 text-sm font-medium">
                          <span className="font-mono">{group.specClass}</span>
                          <span className="ml-3 font-normal text-gray-500">
                            ISO {group.isoTotal} / P&amp;ID {group.pidTotal}
                          </span>
                        </p>
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="py-1">Component</th>
                              <th>Size</th>
                              <th>ISO</th>
                              <th>P&amp;ID</th>
                              <th>ISO description</th>
                              <th>P&amp;ID tag</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.rows.map((row) => (
                              <tr key={`${row.category}-${row.size}`} className="border-b">
                                <td className="py-1">{row.category}</td>
                                <td className="font-mono text-xs">{row.size}</td>
                                <td>{row.isoCount || "-"}</td>
                                <td>
                                  {/* A root valve the legend declares is accounted for as
                                      firmly as one the P&ID draws, so it is added into the
                                      P&ID figure rather than shown as a separate tally. */}
                                  {row.pidCount + row.impliedCount || "-"}
                                </td>
                                <td className="text-xs text-gray-500">{row.isoDetail ?? "-"}</td>
                                <td className="text-xs text-gray-500">
                                  {/* For a valve hidden inside a simplified symbol the useful
                                      answer is which device carries it, so the instrument tag
                                      replaces the "untagged" a P&ID valve would show. */}
                                  {row.impliedDetail ?? row.pidDetail ?? "-"}
                                </td>
                                <td
                                  className={
                                    row.status === "match" ? "text-green-600" : row.status === "count mismatch" ? "text-amber-600" : "text-red-600"
                                  }
                                >
                                  {row.status}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                ))}
            </>
          )}

          {bomBySpec.length > 0 && (
            <>
              <h3 className="mb-2 mt-4 font-medium">BOM by spec, per sheet</h3>
              {bomBySpec.map(({ lineNumber, sheetLabel, page, breaks, groups }) => (
                <div key={`${lineNumber}-${page ?? sheetLabel}`} className="mb-6 rounded border p-3">
                  <p className="mb-1 text-sm font-medium">
                    Sheet {sheetLabel || "?"} <span className="font-normal text-gray-500">&middot; line</span>{" "}
                    <span className="font-mono font-normal">{lineNumber}</span>
                  </p>
                  <p className="mb-2 text-xs text-gray-500">
                    {breaks.length > 1 ? (
                      <>Spec break: {breaks.map((b) => `${b.spec_class}${b.rating ? ` (${b.rating}#)` : ""}`).join(" → ")}</>
                    ) : (
                      <>No spec break on this sheet -- the whole sheet is the title-block class.</>
                    )}
                  </p>
                  {breaks.length > 1 && breaks.some((b) => b.location_note) && (
                    <ul className="mb-2 list-disc pl-5 text-xs text-gray-500">
                      {breaks
                        .filter((b) => b.location_note)
                        .map((b) => (
                          <li key={b.spec_class}>
                            {b.spec_class}: {b.location_note}
                          </li>
                        ))}
                    </ul>
                  )}
                  {groups.map(({ specClass, items }) => (
                    <div key={specClass} className="mb-3">
                      <p className={`text-sm font-medium ${specClass === "Unassigned" ? "text-amber-600" : ""}`}>
                        {specClass} <span className="font-normal text-gray-500">({items.length} item{items.length > 1 ? "s" : ""})</span>
                        {specClass === "Unassigned" && (
                          <span className="ml-2 font-normal text-xs text-amber-600">
                            -- the drawing doesn&apos;t show which side of the break these sit on; confirm against the isometric
                          </span>
                        )}
                      </p>
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="py-1 w-12">Item</th>
                            <th>Description</th>
                            <th className="w-32">Item code</th>
                            <th className="w-16">Qty</th>
                            <th className="w-40">Basis</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item) => (
                            <tr key={item.id} className="border-b">
                              <td className="py-1">{item.itemNo}</td>
                              <td>{item.description}</td>
                              <td className="font-mono text-xs">{item.itemCode}</td>
                              <td>{item.qty}</td>
                              <td className="text-xs text-gray-500">{item.basis || "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

        </section>
      )}

      {!result && <p className="text-gray-500">No extraction result yet for this document.</p>}

      {result && (
        <>
          <section>
            <h2 className="mb-2 font-medium">Extracted tags ({tags.length})</h2>
            <ExtractedTagsTable groups={tagGroups} />
          </section>

          <section>
            <h2 className="mb-2 font-medium">Raw extraction result ({result.schemaVersion})</h2>
            <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap rounded border p-4 text-xs">
              {JSON.stringify(result.rawJson, null, 2)}
            </pre>
          </section>
        </>
      )}
    </div>
  );
}
