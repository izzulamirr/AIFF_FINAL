import { combineAdminText } from "@/lib/parseSheetPage";
import { fitOf, isTight, nearMiss } from "@/lib/containerFit";
import type { IsoDrawingChecks, LineSummary } from "@/lib/lineSummary";
import type { DesignBasisRow, RoutingFittingRow } from "@/lib/verifyIso";

// Every finding from one ISO line's checks -- what a checker hands to the designer.
//
// It reads the same summary the line's page reads, so the report cannot disagree
// with the screen, and it covers every check the page has: design basis, bill of
// material, P&ID, instrument hook-up, spooling and container fit. A check that
// agreed is not listed. What was NOT looked at is listed separately (`notChecked`),
// because "no errors" means something different when nothing was compared.
//
// Two grades of finding. An ERROR is something for the designer to fix or answer.
// INFORMATION is something the screen flags too but that is not the designer's to
// act on -- a P&ID does not itemise flanges, the same valves filed under a
// different class on each drawing -- kept in the list so nothing the page shows is
// missing, but not counted as an error.

export interface DesignBasisIssue {
  field: string;
  iso: string;
  pll: string;
}

export interface BomIssue {
  sheet: string;
  specClass: string;
  itemNo: string;
  size: string;
  quantity: string;
  description: string;
  /**
   * deviation: the admin list has it but disagrees. missing: it has no such line.
   * notChecked: not looked up at all -- for information, not an error.
   */
  kind: "deviation" | "missing" | "notChecked";
  /** What is wrong, in a sentence. */
  problem: string;
  /** The admin line the BOM was compared with, where there is one. */
  adminLine: string | null;
}

export interface RoutingIssue {
  field: string;
  iso: string;
  pid: string;
  problem: string;
}

export interface FittingIssue {
  /** The class the ISO files this component under. */
  specClass: string;
  component: string;
  size: string;
  isoCount: number;
  pidCount: number;
  problem: string;
  /** Set on a finding that is not the designer's to fix; says why. Null on an error. */
  note: string | null;
}

export interface HookupIssue {
  instrument: string;
  label: string;
  /** The piping-scope components the typical requires and the ISO does not show. */
  missing: Array<{ item: string; description: string; size: string; quantity: string }>;
  /** Set where no typical covers the instrument, so nothing could be checked. */
  noTypical: string | null;
}

export interface SpoolingIssue {
  sheet: string;
  weld: string;
  weldType: string;
  size: string;
  problem: string;
}

export interface ContainerIssue {
  sheet: string;
  spool: string;
  size: string;
  problem: string;
  /** Set on a finding that is only a heads-up. Null on an error. */
  note: string | null;
}

export interface DrawingReport {
  documentId: string;
  fileName: string;
  designBasis: { against: string | null; issues: DesignBasisIssue[] };
  bom: BomIssue[];
  routing: RoutingIssue[];
  fittings: FittingIssue[];
  hookup: HookupIssue[];
  spooling: SpoolingIssue[];
  containers: ContainerIssue[];
  /** Checks that could not be run for this drawing, and why. */
  notChecked: string[];
  /** Checks that ran and found nothing wrong. */
  clear: string[];
  /** Errors only. */
  issueCount: number;
  /** Findings that are for information. */
  infoCount: number;
}

export interface IsoReport {
  drawings: DrawingReport[];
  totals: { designBasis: number; bom: number; pid: number; hookup: number; spooling: number; containers: number; all: number; info: number };
}

const dash = (v: string | null | undefined) => (v == null || v.trim() === "" ? "-" : v);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function designBasisIssues(rows: DesignBasisRow[]): DesignBasisIssue[] {
  return rows.filter((r) => r.status === "mismatch").map((r) => ({ field: r.field, iso: dash(r.isoValue), pll: dash(r.pllValue) }));
}

function routingIssues(rows: RoutingFittingRow[]): RoutingIssue[] {
  return rows
    .filter((r) => r.status === "mismatch" || r.status === "iso only")
    .map((r) => ({
      field: r.field,
      iso: dash(r.isoValue),
      pid: dash(r.pidValue),
      problem: r.status === "mismatch" ? "ISO and P&ID disagree" : "On the ISO, not found on the P&ID",
    }));
}

// What a BOM row that the admin list does not itemise actually is. Supports and
// instruments are not the designer's to answer for here and are left out of the report
// altogether; a stud bolt is listed, because its check is not built yet.
const SPEC_TEXT = /\bA\d{3}\b|\bASTM\b|\bASME\b|\bAPI\b|\bBS\s?\d|\bISO\b|\bSCH|\bBODY\b|\bTRIM\b|\bWCB\b|\bWPB\b/i;
const INSTRUMENT_TAG = /^[A-Z]{1,4}[- ]?\d{3,5}[A-Z]?$/i;

function unlistedKind(description: string, componentType: string): "support" | "instrument" | "stud" | "other" {
  const text = `${componentType} ${description}`;
  if (/\bsupport\b/i.test(text)) return "support";
  if (/\bstud\s*bolt\b|\bbolt\s*set\b/i.test(text)) return "stud";
  if (/\binstrument\b/i.test(text) || INSTRUMENT_TAG.test(description.trim())) return "instrument";
  // A "control valve" with nothing else said about it -- no material, standard, body or
  // trim -- is the instrument's own valve, drawn as a symbol, not a piping item.
  if (/\bcontrol\s*valve\b/i.test(description) && !SPEC_TEXT.test(description)) return "instrument";
  return "other";
}

function bomIssues(sheets: IsoDrawingChecks["mto"]["sheetData"]): BomIssue[] {
  const out: BomIssue[] = [];
  for (const sheet of sheets) {
    for (const group of sheet.groups) {
      for (const row of group.rows) {
        const { check } = row;
        if (check.status === "match") continue;
        const unlisted = check.status === "skipped" ? unlistedKind(row.description, row.componentType) : "other";
        if (unlisted === "support" || unlisted === "instrument") continue;
        const kind = check.status === "deviation" ? "deviation" : check.status === "missing" ? "missing" : "notChecked";
        const adminLine = check.adminMatches[0] ? combineAdminText(check.adminMatches[0]) : null;
        const problem =
          check.status === "deviation"
            ? check.adminMismatches.map((m) => `${sentence(m.attribute)}: BOM says ${m.wanted}, admin list has ${m.found.join(" / ")}`).join("; ")
            : unlisted === "stud"
              ? "Stud bolt calculation is not completed yet."
              : (check.note ?? "Not in the admin item list");
        out.push({
          sheet: sheet.sheetLabel || (sheet.page != null ? `page ${sheet.page}` : "?"),
          specClass: group.specClass,
          itemNo: row.itemNo || "-",
          size: row.size,
          quantity: row.quantity,
          description: row.description,
          kind,
          problem,
          adminLine,
        });
      }
    }
  }
  return out;
}

// Instrument symbols, which the ISO and P&ID name differently (an ISA tag on one, a
// "flow transmitter" on the other) and which the hook-up check covers.
const INSTRUMENT = /instrument|transmitter|indicator|switch|gauge|element/i;

// Every row the fittings match flags, as the screen shows it, per class. Each is graded:
// a real disagreement is an error; one the screen flags for a reason that is not the
// designer's to fix carries a note saying why.
function fittingIssues(groups: IsoDrawingChecks["pid"]["fittingGroups"]): FittingIssue[] {
  // A spec break splits one run's valves between two or three classes, and which class
  // an item is filed under is the extraction's judgement. Where the totals for a
  // component across all classes agree, the per-class rows are only that filing.
  const totals = new Map<string, { iso: number; accounted: number }>();
  for (const g of groups) {
    for (const r of g.rows) {
      const key = `${r.category}|${r.size}`;
      const t = totals.get(key) ?? { iso: 0, accounted: 0 };
      t.iso += r.isoCount;
      t.accounted += r.pidCount + r.impliedCount;
      totals.set(key, t);
    }
  }

  const out: FittingIssue[] = [];
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.status === "match") continue;
      const component = sentence(String(r.category));
      const accounted = r.pidCount + r.impliedCount;
      const legend = r.impliedCount > 0 ? ` (including ${plural(r.impliedCount, "root valve")} the legend declares)` : "";
      const problem =
        r.status === "count mismatch"
          ? `ISO has ${r.isoCount}, P&ID has ${accounted}${legend}`
          : r.status === "iso only"
            ? `${r.isoCount} on the ISO, none on the P&ID`
            : `${accounted} on the P&ID, none in the ISO's bill of material`;

      const total = totals.get(`${r.category}|${r.size}`)!;
      let note: string | null = null;
      if (INSTRUMENT.test(component)) {
        note = "Instruments are named differently on the two drawings; see the hook-up check.";
      } else if (total.iso === total.accounted) {
        note = `Totals agree across classes (${total.iso} on each); the class this is filed under differs, not the count.`;
      }

      out.push({ specClass: g.specClass, component, size: r.size, isoCount: r.isoCount, pidCount: accounted, problem, note });
    }
  }
  // Errors first.
  return out.sort((a, b) => Number(a.note != null) - Number(b.note != null));
}

function hookupIssues(drawing: NonNullable<LineSummary["hookup"]>["drawings"][number] | undefined): HookupIssue[] {
  if (!drawing) return [];
  const out: HookupIssue[] = [];
  for (const r of drawing.verification.results) {
    if (r.missingCount > 0) {
      out.push({
        instrument: r.instrumentTag,
        label: r.instrumentLabel,
        missing: r.checks
          .filter((c) => c.status === "unmatched")
          .map((c) => ({ item: c.item.itemNo ?? "-", description: c.item.description, size: dash(c.item.size), quantity: dash(c.item.quantity) })),
        noTypical: null,
      });
    } else if (!r.sheet) {
      out.push({
        instrument: r.instrumentTag,
        label: r.instrumentLabel,
        missing: [],
        noTypical: `No hook-up typical covers a ${r.measuredVariable ?? "?"} instrument${r.service ? ` on ${r.service} service` : ""}, so its piping could not be checked.`,
      });
    }
  }
  return out;
}

function spoolingIssues(sheets: NonNullable<LineSummary["spooling"]>["docs"][number]["sheets"] | undefined): SpoolingIssue[] {
  if (!sheets) return [];
  const out: SpoolingIssue[] = [];
  for (const sheet of sheets) {
    const label = sheet.sheetLabel || (sheet.page != null ? `page ${sheet.page}` : "?");
    for (const group of sheet.weldsBySpool) {
      for (const w of group.welds) {
        if (w.spoolOf === "-") {
          out.push({ sheet: label, weld: w.weldNo, weldType: w.weldType, size: w.size, problem: "Not assigned to any spool." });
        } else if (w.drawingSpool && w.drawingSpool !== w.spoolOf) {
          out.push({
            sheet: label,
            weld: w.weldNo,
            weldType: w.weldType,
            size: w.size,
            problem: `Stored under spool ${w.spoolOf}; the drawing places it in ${w.drawingSpool}.`,
          });
        }
      }
    }
  }
  return out;
}

function axesOf(e: { upDownMm: number; nsMm: number; ewMm: number }): string {
  return [e.upDownMm > 0 && `UP-DOWN ${e.upDownMm}`, e.nsMm > 0 && `N-S ${e.nsMm}`, e.ewMm > 0 && `E-W ${e.ewMm}`].filter(Boolean).join(" · ") || "-";
}

function containerIssues(spools: NonNullable<LineSummary["containers"]>["docs"][number]["spools"] | undefined): ContainerIssue[] {
  if (!spools) return [];
  const out: ContainerIssue[] = [];
  for (const s of spools) {
    const sheet = s.sheetLabel || (s.page != null ? `page ${s.page}` : "?");
    const fit = fitOf(s);
    const allowance = s.fieldWelds > 0 ? ` (with the 150 mm field-weld allowance for ${plural(s.fieldWelds, "field weld")})` : "";
    if (!fit || !s.envelope) {
      out.push({
        sheet,
        spool: s.spoolNo,
        size: "not read",
        problem: "No size could be read from the drawing, so shipping in a 20ft container was not checked.",
        note: "Not a fault on the drawing.",
      });
      continue;
    }
    const size = axesOf(s.envelope);
    const best = fit.smallest;
    if (best) {
      if (isTight(best)) {
        out.push({
          sheet,
          spool: s.spoolNo,
          size,
          problem: `Fits a 20ft container with only ${best.tightestMm} mm to spare${allowance}. Confirm against the actual container.`,
          note: "Heads-up, not an error.",
        });
      }
      continue;
    }
    const close = nearMiss(fit);
    out.push({
      sheet,
      spool: s.spoolNo,
      size,
      problem: close
        ? `Misses a 20ft container by ${close.shortfallMm} mm${allowance}. Measure the actual container.`
        : `Does not fit a 20ft container${allowance}. The spool has to be cut differently.`,
      note: close ? "Near miss: within the range containers vary." : null,
    });
  }
  // Errors first.
  return out.sort((a, b) => Number(a.note != null) - Number(b.note != null));
}

export function buildIsoReport(summary: LineSummary): IsoReport | null {
  if (!summary.checks) return null;

  const drawings = summary.checks.map((d): DrawingReport => {
    const hookupDrawing = summary.hookup?.drawings.find((h) => h.documentId === d.documentId);
    const spoolDoc = summary.spooling?.docs.find((x) => x.id === d.documentId);
    const containerDoc = summary.containers?.docs.find((x) => x.id === d.documentId);

    const designBasis = { against: d.pll.against, issues: d.pll.state === "compared" ? designBasisIssues(d.pll.rows) : [] };
    const bom = d.mto.available ? bomIssues(d.mto.sheetData) : [];
    const bomErrors = bom.filter((b) => b.kind !== "notChecked").length;
    const routing = d.pid.state === "compared" ? routingIssues(d.pid.routingRows) : [];
    const fittings = d.pid.state === "compared" ? fittingIssues(d.pid.fittingGroups) : [];
    const hookup = hookupIssues(hookupDrawing);
    const spooling = spoolingIssues(spoolDoc?.sheets);
    const containers = containerIssues(containerDoc?.spools);

    const notChecked: string[] = [];
    const clear: string[] = [];

    if (d.pll.state === "none") notChecked.push("ISO vs line list: no line list has been read for this project.");
    else if (d.pll.state === "notFound") notChecked.push("ISO vs line list: this line is not in the line list.");
    else if (designBasis.issues.length === 0) clear.push("ISO vs line list");

    if (!d.mto.available) notChecked.push("Bill of material vs admin item list: no admin item list has been uploaded.");
    else if (bomErrors === 0) clear.push("Bill of material vs admin item list");

    if (d.pid.state === "none") notChecked.push("ISO vs P&ID: no P&ID has been read for this project.");
    else if (d.pid.state === "notFound") notChecked.push("ISO vs P&ID: this line is not on any P&ID.");
    else if (routing.length === 0 && fittings.length === 0) clear.push("ISO vs P&ID");

    if (!summary.hookup || summary.hookup.typicals === 0) notChecked.push("Instrument hook-up: no hook-up typicals are available for this project.");
    else if (!hookupDrawing || hookupDrawing.verification.results.length === 0) notChecked.push("Instrument hook-up: no instruments in this ISO's bill of material.");
    else if (hookup.length === 0) clear.push("Instrument hook-up");

    if (!summary.spooling || !spoolDoc) notChecked.push("Spooling: no spool or weld data has been read for this line.");
    else if (spooling.length === 0) clear.push("Spooling");

    if (!summary.containers || !containerDoc) notChecked.push("Container check: no spools have been read for this line.");
    else if (containers.length === 0) clear.push("Container check");

    const isInfo = (x: { note: string | null }) => x.note != null;
    const errors =
      designBasis.issues.length +
      bomErrors +
      routing.length +
      fittings.filter((f) => !isInfo(f)).length +
      hookup.filter((h) => h.noTypical == null).length +
      spooling.length +
      containers.filter((c) => !isInfo(c)).length;
    const info = bom.filter((b) => b.kind === "notChecked").length + fittings.filter(isInfo).length + hookup.filter((h) => h.noTypical != null).length + containers.filter(isInfo).length;

    return {
      documentId: d.documentId,
      fileName: d.fileName,
      designBasis,
      bom,
      routing,
      fittings,
      hookup,
      spooling,
      containers,
      notChecked,
      clear,
      issueCount: errors,
      infoCount: info,
    };
  });

  const sum = (f: (d: DrawingReport) => number) => drawings.reduce((n, d) => n + f(d), 0);
  const totals = {
    designBasis: sum((d) => d.designBasis.issues.length),
    bom: sum((d) => d.bom.filter((b) => b.kind !== "notChecked").length),
    pid: sum((d) => d.routing.length + d.fittings.filter((f) => f.note == null).length),
    hookup: sum((d) => d.hookup.filter((h) => h.noTypical == null).length),
    spooling: sum((d) => d.spooling.length),
    containers: sum((d) => d.containers.filter((c) => c.note == null).length),
    all: sum((d) => d.issueCount),
    info: sum((d) => d.infoCount),
  };
  return { drawings, totals };
}
