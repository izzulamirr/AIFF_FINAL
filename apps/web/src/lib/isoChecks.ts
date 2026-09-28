import { and, desc, eq, inArray } from "drizzle-orm";
import { documents, documentPages, extractionJobs, extractedTags } from "@easy/db";
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
import { kindOfDocument } from "@/lib/docTypes";
import { extractSheetItems, type SheetItem } from "@/lib/parseSheetPage";
import { checkBomItem, type AdminCheck } from "@/lib/verifyBomCrossCheck";

// An ISO's cross-document checks: its design basis against the line list (PLL),
// its routing and fittings against the project's P&IDs, and its bill of
// material grouped by the spec class that governs each item.
//
// Lived inside the ISO document page until a line's summary needed the same
// answers. It is here so the page and the summary read one computation and
// cannot drift.

type DocumentRow = typeof documents.$inferSelect;
type TagRow = typeof extractedTags.$inferSelect;

export type IsoChecks = Awaited<ReturnType<typeof buildIsoChecks>>;

/** One BOM item, checked against the admin item list. */
export interface MtoBomRow {
  id: number;
  itemNo: string;
  componentType: string;
  size: string;
  quantity: string;
  description: string;
  itemCode: string;
  /** The verdict, with the admin line(s) it rests on and anything they contradict. */
  check: AdminCheck;
}

/**
 * `tags` are the ISO document's own extracted tags. Everything it is compared
 * against -- sibling documents, PLL, P&IDs, the legend -- is read here.
 */
export async function buildIsoChecks({
  projectId,
  docId,
  document,
  tags,
}: {
  projectId: string;
  docId: string;
  document: DocumentRow;
  tags: TagRow[];
}) {
  const db = getDb();
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

  // MTO: this same BOM checked against the admin's own item-list export (an
  // XLSX, uploaded on the project page -- see lib/docTypes.ts). One row per BOM
  // item, grouped the same way bomBySpec is -- by sheet, then by the class
  // governing each item -- so the two views line up.
  //
  // `Unassigned` rows (the drawing does not say which side of a spec break
  // they sit on) are never checked: there is no class to look them up under.
  let mtoBySpec: Array<{
    lineNumber: string;
    sheetLabel: string;
    page: number | null;
    groups: Array<{ specClass: string; rows: MtoBomRow[] }>;
  }> = [];
  // Whether ANY admin item list exists for this project at all -- gates
  // whether the MTO card shows real results or the "not set up yet"
  // placeholder. A list that exists but has nothing for THIS item's class is a
  // different, per-row state ("No admin list"), not this flag.
  let mtoAdminAvailable = false;

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

  // The admin's own item list, one flat sheet whose every line names the class
  // it belongs to. What each BOM item is looked up in, under the class the
  // extraction gave that item.
  const adminSpecDocs = siblingDocs.filter((d) => d.docType === "spec_sheet" && kindOfDocument(d.docType, d.fileName)?.key === "admin_spec");
  const adminItems: SheetItem[] = [];
  if (adminSpecDocs.length > 0) {
    const adminPages = await db
      .select()
      .from(documentPages)
      .where(inArray(documentPages.documentId, adminSpecDocs.map((d) => d.id)));
    for (const p of adminPages) adminItems.push(...extractSheetItems(p.pageText));
  }
  mtoAdminAvailable = adminItems.length > 0;

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
        // The class the EXTRACTION gave this item -- what the drawing says, read where the
        // item sits on the sheet. With no break on the sheet the title-block class governs
        // every row, so an unset class there is not an open question. Nothing here
        // re-files an item under another class.
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

  // MTO: the same BOM items, looked up in the ADMIN's item list under the class
  // each is filed under. (The client specs and the admin item list are read
  // above, ahead of the BOM grouping, which reads them.)
  mtoBySpec = bomBySpec.map(({ lineNumber, sheetLabel, page, groups }) => {
    // The specs THIS SHEET has: the classes its BOM items are filed under (AC03N and BC70N on
    // sheet 5). An item that fails its own class is only ever compared with these.
    const sheetClasses = groups.map((g) => g.specClass).filter((c) => c !== "Unassigned");
    return {
      lineNumber,
      sheetLabel,
      page,
      // Every item stays under the class the extraction gave it.
      groups: groups.map(({ specClass, items }) => ({
        specClass,
        rows: items.map((displayItem): MtoBomRow => {
          const tag = tags.find((t) => t.id === displayItem.id);
          const a = (tag?.attributes as Record<string, unknown> | undefined) ?? {};
          return {
            id: displayItem.id,
            itemNo: displayItem.itemNo,
            componentType: String(a.component_type ?? "-"),
            size: String(a.size ?? "-"),
            quantity: displayItem.qty,
            description: displayItem.description,
            itemCode: displayItem.itemCode,
            check: checkBomItem(a, specClass, sheetClasses, adminItems),
          };
        }),
      })),
    };
  });


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

  return { designBasis, routingFittings, bomBySpec, mtoBySpec, mtoAdminAvailable };
}
