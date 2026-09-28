import { asc, eq } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import { getDb } from "@/lib/db";
import { buildSpoolSheets, spoolingTotals, type SpoolSheet } from "@/lib/spooling";
import { buildContainerSpools, type ContainerSpool } from "@/lib/containers";
import { summariseFits, type FitSummary } from "@/lib/containerFit";
import { loadHookupSheets, verifyIsoHookup, type HookupVerification } from "@/lib/hookupVerification";
import { buildIsoChecks, type IsoChecks } from "@/lib/isoChecks";
import { lineKey, type IsoLine } from "@/lib/isoLines";
import type { DesignBasisRow, RoutingFittingRow, ValveMatchGroup } from "@/lib/verifyIso";

// The headline numbers for each review of one ISO line -- what the line's page
// shows before anyone opens a tool.
//
// It does not compute anything of its own. Each figure comes from the same
// builder the tool's own page uses (buildSpoolSheets, buildContainerSpools,
// verifyIsoHookup, buildIsoChecks), over the same documents filtered to the same
// line, so a summary and the page behind it cannot give different answers.
//
// Each section stands alone: one that cannot be worked out is null, and the
// others still show. A summary is a convenience -- it must not be able to take
// the page down with it.
//
// It carries the DATA as well as the counts: the line page shows a review's
// headline numbers folded up and the full data when it is opened, so both come
// from here rather than from a second trip to another page.

export interface HookupDrawingSummary {
  documentId: string;
  fileName: string;
  /** The full verification, for showing the instruments and their checks. */
  verification: HookupVerification;
  /** Instruments the ISO's bill of material names. */
  instruments: number;
  /** With a typical, and every piping-scope item found on the ISO. */
  matched: number;
  /** With at least one piping-scope item the ISO is missing. */
  withMissing: number;
  /** Piping-scope items missing, in all. */
  missingItems: number;
  /** Instruments no typical in the set covers. */
  noTypical: number;
}

/**
 * How a comparison stands. `none`: there is nothing to compare against yet (no
 * PLL, no P&ID extracted). `notFound`: there is, but this line is not in it.
 */
export type CheckState = "none" | "notFound" | "compared";

/** One ISO drawing's cross-document checks for the line. */
export interface IsoDrawingChecks {
  documentId: string;
  fileName: string;
  /**
   * Design basis: the ISO's title block against the line list (PLL). The rows
   * themselves, not a count of them -- this is the one check the line page shows
   * as the comparison table it is.
   */
  pll: { state: CheckState; against: string | null; rows: DesignBasisRow[] };
  /** Routing & fittings, and the fittings match, against the project's P&IDs. */
  pid: {
    state: CheckState;
    against: string[];
    /** Routing and fitting counts, and the in-line components paired one for one. */
    routingRows: RoutingFittingRow[];
    fittingGroups: ValveMatchGroup[];
    routing: { rows: number; match: number; mismatch: number; isoOnly: number; notCompared: number };
    fittings: { components: number; match: number; countMismatch: number; isoOnly: number; pidOnly: number };
  };
  /** The bill of material as extracted, ahead of a check against the admin item list. */
  bom: { sheets: number; items: number; classes: number; unassigned: number; sheetData: IsoChecks["bomBySpec"] };
  /**
   * The same BOM, looked up in the admin's own item list. Not `available` at all
   * until an admin item list has been uploaded to the project -- see
   * lib/isoChecks.ts's mtoAdminAvailable.
   */
  mto: {
    available: boolean;
    /** Every BOM row on the line. */
    items: number;
    /** The admin list has a line for it and nothing the BOM states is contradicted. */
    match: number;
    /** The admin list has the component at that size, but a stated attribute differs. */
    deviations: number;
    /** The admin list has no such component, or none at this size. */
    notInList: number;
    /** Not looked up: supports, instruments, control valves, stud bolts, no class, or no admin lines for the class. */
    notChecked: number;
    sheetData: IsoChecks["mtoBySpec"];
  };
}

export interface LineSummary {
  /** The ISO documents that carry this line. */
  drawings: Array<{ id: string; fileName: string }>;
  spooling: {
    totals: ReturnType<typeof spoolingTotals>;
    /** Per document, as the spooling page lists them. */
    docs: Array<{ id: string; fileName: string; sheets: SpoolSheet[] }>;
  } | null;
  containers: {
    fit: FitSummary;
    docs: Array<{ id: string; fileName: string; spools: ContainerSpool[] }>;
  } | null;
  hookup: {
    /** Typicals extracted from the project's hook-up drawings. None means nothing can be checked. */
    typicals: number;
    /** One entry per ISO: a line in two documents is verified in each, not summed. */
    drawings: HookupDrawingSummary[];
  } | null;
  /** One entry per ISO, for the same reason. */
  checks: IsoDrawingChecks[] | null;
}

const count = <T extends { status: string }>(rows: T[], status: T["status"]) => rows.filter((r) => r.status === status).length;

function summariseDrawingChecks(doc: { id: string; fileName: string }, checks: IsoChecks, key: string): IsoDrawingChecks {
  // ---- ISO vs PLL. Nothing computed at all means no PLL was extracted; a null
  // `rows` means there is one and this line is not in it.
  const basis = checks.designBasis.find((e) => lineKey(e.lineNumber) === key);
  const pll: IsoDrawingChecks["pll"] = { state: "none", against: null, rows: [] };
  if (basis) {
    if (!basis.rows) pll.state = "notFound";
    else {
      pll.state = "compared";
      pll.against = basis.pllDocName;
      pll.rows = basis.rows;
    }
  }

  // ---- ISO vs P&ID, the same way.
  const routing = checks.routingFittings.find((e) => lineKey(e.lineNumber) === key);
  const pid: IsoDrawingChecks["pid"] = {
    state: "none",
    against: [],
    routingRows: [],
    fittingGroups: [],
    routing: { rows: 0, match: 0, mismatch: 0, isoOnly: 0, notCompared: 0 },
    fittings: { components: 0, match: 0, countMismatch: 0, isoOnly: 0, pidOnly: 0 },
  };
  if (routing) {
    if (!routing.rows) pid.state = "notFound";
    else {
      pid.state = "compared";
      pid.against = routing.pidDocNames;
      pid.routingRows = routing.rows;
      // Valves and instruments only. A P&ID does not draw flanges or gaskets, so a flange
      // row can only ever read "on the ISO, none on the P&ID" -- a comparison with nothing
      // on one side. Left out here, at the source, so the card, its counts and the error
      // report all agree.
      pid.fittingGroups = (routing.valveMatch ?? [])
        .map((g) => {
          const rows = g.rows.filter((r) => !/flange|gasket/i.test(String(r.category)));
          return {
            ...g,
            rows,
            isoTotal: rows.reduce((n, r) => n + r.isoCount, 0),
            pidTotal: rows.reduce((n, r) => n + r.pidCount, 0),
          };
        })
        .filter((g) => g.rows.length > 0);
      pid.routing = {
        rows: routing.rows.length,
        match: count(routing.rows, "match"),
        mismatch: count(routing.rows, "mismatch"),
        isoOnly: count(routing.rows, "iso only"),
        notCompared: count(routing.rows, "not compared"),
      };
      const fittingRows = pid.fittingGroups.flatMap((g) => g.rows);
      pid.fittings = {
        components: fittingRows.length,
        match: count(fittingRows, "match"),
        countMismatch: count(fittingRows, "count mismatch"),
        isoOnly: count(fittingRows, "iso only"),
        pidOnly: count(fittingRows, "pid only"),
      };
    }
  }

  // ---- BOM, as extracted.
  const sheets = checks.bomBySpec.filter((s) => lineKey(s.lineNumber) === key);
  const groups = sheets.flatMap((s) => s.groups);
  const bom: IsoDrawingChecks["bom"] = {
    sheets: sheets.length,
    items: groups.reduce((n, g) => n + g.items.length, 0),
    classes: new Set(groups.filter((g) => g.specClass !== "Unassigned").map((g) => g.specClass)).size,
    unassigned: groups.filter((g) => g.specClass === "Unassigned").reduce((n, g) => n + g.items.length, 0),
    sheetData: sheets,
  };

  // ---- MTO: the same BOM, checked. A row counts as `checked` once it has a
  // real result (its own class resolved to something -- "Unassigned" rows
  // are skipped entirely, see lib/isoChecks.ts). Of those:
  //   match       the admin item list has a line for it and agrees
  //   deviations  the admin item list has the component at that size, but
  //               something the BOM states (schedule, angle, construction,
  //               pressure class) differs
  //   notInList   the admin item list has no such component, or none at this size
  //   notChecked  not something the admin list itemises, or nothing to look it up in
  const mtoSheets = checks.mtoBySpec.filter((s) => lineKey(s.lineNumber) === key);
  const mtoRows = mtoSheets.flatMap((s) => s.groups.flatMap((g) => g.rows));
  const countOf = (...statuses: string[]) => mtoRows.filter((r) => statuses.includes(r.check.status)).length;
  const mto: IsoDrawingChecks["mto"] = {
    available: checks.mtoAdminAvailable,
    items: mtoRows.length,
    match: countOf("match"),
    deviations: countOf("deviation", "wrong_spec"),
    notInList: countOf("missing"),
    notChecked: countOf("skipped", "no_list"),
    sheetData: mtoSheets,
  };

  return { documentId: doc.id, fileName: doc.fileName, pll, pid, bom, mto };
}

export async function summariseLine(projectId: string, line: IsoLine): Promise<LineSummary> {
  const db = getDb();

  const projectDocs = await db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(asc(documents.uploadedAt), asc(documents.id));
  const isoDocs = projectDocs.filter((d) => d.docType === "iso" && line.documentIds.includes(d.id));

  // Several sections read the same document's tags, so each is loaded once.
  const tagCache = new Map<string, Array<typeof extractedTags.$inferSelect>>();
  const tagsOf = async (documentId: string) => {
    const hit = tagCache.get(documentId);
    if (hit) return hit;
    const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, documentId));
    tagCache.set(documentId, tags);
    return tags;
  };

  // Spooling and the container check both read spools off the same tags.
  let spooling: LineSummary["spooling"] = null;
  let containers: LineSummary["containers"] = null;
  try {
    const spoolDocs: NonNullable<LineSummary["spooling"]>["docs"] = [];
    const containerDocs: NonNullable<LineSummary["containers"]>["docs"] = [];
    for (const doc of isoDocs) {
      const tags = await tagsOf(doc.id);
      const rows = tags.map((t) => ({ id: t.id, tagType: t.tagType, tagNumber: t.tagNumber, sourcePage: t.sourcePage, attributes: t.attributes }));
      // A document can hold more than one line; keep only this one's. And, as the
      // pages do, list only the documents that have something to show.
      const sheets: SpoolSheet[] = buildSpoolSheets(rows).filter((s) => lineKey(s.lineNumber) === line.key);
      const spools: ContainerSpool[] = buildContainerSpools(rows).filter((s) => lineKey(s.lineNumber) === line.key);
      if (sheets.length > 0) spoolDocs.push({ id: doc.id, fileName: doc.fileName, sheets });
      if (spools.length > 0) containerDocs.push({ id: doc.id, fileName: doc.fileName, spools });
    }
    spooling = { totals: spoolingTotals(spoolDocs.flatMap((d) => d.sheets)), docs: spoolDocs };
    containers = { fit: summariseFits(containerDocs.flatMap((d) => d.spools)), docs: containerDocs };
  } catch (err) {
    console.error("Line summary: could not read the spools for", line.lineNumber, err);
  }

  let hookup: LineSummary["hookup"] = null;
  try {
    const typicals = await loadHookupSheets(projectDocs.filter((d) => d.docType === "hookup").map((d) => d.id));
    const drawings: HookupDrawingSummary[] = [];
    if (typicals.length > 0) {
      for (const doc of isoDocs) {
        const verification = await verifyIsoHookup({ projectDocs, sheets: typicals, isoId: doc.id, chosenLineKey: line.key });
        const { results } = verification;
        drawings.push({
          documentId: doc.id,
          fileName: doc.fileName,
          verification,
          instruments: results.length,
          matched: results.filter((r) => r.sheet && r.missingCount === 0).length,
          withMissing: results.filter((r) => r.missingCount > 0).length,
          missingItems: results.reduce((sum, r) => sum + r.missingCount, 0),
          noTypical: results.filter((r) => !r.sheet).length,
        });
      }
    }
    hookup = { typicals: typicals.length, drawings };
  } catch (err) {
    console.error("Line summary: could not verify the hook-up for", line.lineNumber, err);
  }

  let checks: LineSummary["checks"] = null;
  try {
    checks = [];
    for (const doc of isoDocs) {
      const isoChecks = await buildIsoChecks({ projectId, docId: doc.id, document: doc, tags: await tagsOf(doc.id) });
      checks.push(summariseDrawingChecks(doc, isoChecks, line.key));
    }
  } catch (err) {
    checks = null;
    console.error("Line summary: could not run the ISO checks for", line.lineNumber, err);
  }

  return { drawings: isoDocs.map((d) => ({ id: d.id, fileName: d.fileName })), spooling, containers, hookup, checks };
}
