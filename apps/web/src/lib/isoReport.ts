import { combineAdminText } from "@/lib/parseSheetPage";
import { fitOf, isTight, nearMiss } from "@/lib/containerFit";
import type { IsoDrawingChecks, LineSummary } from "@/lib/lineSummary";
import type { DesignBasisRow, RoutingFittingRow } from "@/lib/verifyIso";
import { splitMergedRow } from "@/lib/verifyBomCrossCheck";
import type { AdminAttributeMismatch } from "@/lib/parseSheetPage";
import { instrumentPendingRemark, type HoldStatus } from "@/lib/pending";

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
  kind: "deviation" | "missing" | "wrongSpec" | "notChecked";
  /** What is wrong, in a few words. */
  problem: string;
  /** The admin line the BOM was compared with, where there is one. */
  adminLine: string | null;
  /** Who has to do what about it, where the check can say. */
  action: string | null;
  /**
   * The items the BOM cell holds. More than one where the drawing lists several items
   * under one ID ("PIPE ... PIPE ...") -- a drafting fault in itself, and the reason
   * such a description reads twice as long as its neighbours.
   */
  parts: string[];
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
  /** The spool the drawing puts the weld in, where it differs from the stored one. */
  drawingSpool: string | null;
}

export interface ContainerIssue {
  sheet: string;
  spool: string;
  size: string;
  problem: string;
  /** Set on a finding that is only a heads-up. Null on an error. */
  note: string | null;
}

/**
 * Something on a sheet that is waiting on somebody -- on hold, or pending data from
 * the client or a vendor. Not an error: the report is issued with these listed, so
 * one unanswerable item does not hold the whole line back.
 */
export interface PendingNote {
  sheet: string;
  status: HoldStatus;
  /** The item, as a reader would name it: "Instrument FT-1234", "BOM item 7: GATE VALVE ...". */
  what: string;
  remark: string;
  /** Who marked it, where a person did. */
  markedBy: string | null;
}

export interface DrawingReport {
  documentId: string;
  fileName: string;
  /** On hold or pending, sheet by sheet. Not counted in issueCount or infoCount. */
  pending: PendingNote[];
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
  totals: { designBasis: number; bom: number; pid: number; hookup: number; spooling: number; containers: number; all: number; info: number; pending: number };
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
      // The P&ID is the reference: the ISO is what is wrong, never "the two disagree".
      problem: r.status === "mismatch" ? "Differs from P&ID" : "Not on the P&ID",
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

const short = (t: string) => (t.length > 80 ? `${t.slice(0, 80)}...` : t);

/** BOM items on hold or pending -- listed as pending, never as BOM errors. */
function bomPending(sheets: IsoDrawingChecks["mto"]["sheetData"]): PendingNote[] {
  const out: PendingNote[] = [];
  for (const sheet of sheets) {
    for (const group of sheet.groups) {
      for (const row of group.rows) {
        if (!row.hold) continue;
        out.push({
          sheet: sheet.sheetLabel || (sheet.page != null ? `page ${sheet.page}` : "?"),
          status: row.hold.status,
          what: `BOM item ${row.itemNo || "-"}: ${short(row.description)}`,
          remark: row.hold.remark,
          markedBy: row.hold.markedByName ?? null,
        });
      }
    }
  }
  return out;
}

// "Material: A234 WPB, should be A105N" -- what the BOM states, then what the spec wants.
const fault = (m: AdminAttributeMismatch) => `${sentence(m.attribute)}: ${m.wanted}, should be ${m.found.join(" / ")}`;

function bomIssues(sheets: IsoDrawingChecks["mto"]["sheetData"]): BomIssue[] {
  const out: BomIssue[] = [];
  for (const sheet of sheets) {
    for (const group of sheet.groups) {
      for (const row of group.rows) {
        const { check } = row;
        if (check.status === "match" || row.hold) continue;
        const unlisted = check.status === "skipped" ? unlistedKind(row.description, row.componentType) : "other";
        if (unlisted === "support" || unlisted === "instrument") continue;
        const kind = check.status === "wrong_spec" ? "wrongSpec" : check.status === "deviation" ? "deviation" : check.status === "missing" ? "missing" : "notChecked";
        const parts = splitMergedRow(row.description);
        const own = group.specClass;
        const classes = check.wrongSpec ?? [];
        // A wrong-class item was matched to ANOTHER class's line, so that line is not
        // what it "should be" under its own class.
        const adminLine = kind !== "wrongSpec" && check.adminMatches[0] ? combineAdminText(check.adminMatches[0]) : null;
        // Short facts from the check's own findings, said from the BOM's side (the admin
        // spec is the reference) -- not the check's sentences, which quote the item back.
        const faults = check.adminMismatches.map(fault);
        const said =
          kind === "wrongSpec"
            ? [classes.length > 0 ? `Belongs to ${classes.join(" / ")}, not ${own}` : `Does not match ${own}${/NACE/i.test(check.note ?? "") ? " (NACE service)" : ""}`, ...faults]
            : kind === "deviation"
              ? faults.length > 0
                ? faults
                : [check.note ?? "Differs from the spec"]
              : [(check.note ?? "Not in the spec").replace(/^BOM item is not in the \S+ spec:\s*/i, "").replace(/\.$/, "")];
        // A stud's order size travels with its verdict.
        const problem = [...(parts.length > 1 ? [`${parts.length} items under one ID`] : []), ...said, ...(check.detail ? [check.detail] : [])]
          .map((s) => s.replace(/\.$/, ""))
          .join(". ");
        const fix =
          kind === "wrongSpec"
            ? classes.length > 0
              ? `Use the ${own} item, or file under ${classes.join(" / ")}`
              : `Use an item from the ${own} spec`
            : kind === "deviation"
              ? `Correct to the ${own} spec`
              : kind === "missing"
                ? /^BOM size/i.test(check.note ?? "")
                  ? `Use a size the ${own} spec lists`
                  : `Replace with an item from ${own}`
                : null;
        const action = fix && parts.length > 1 ? `Split into separate IDs. ${fix}` : fix;
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
          action,
          parts,
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
      const legend = r.impliedCount > 0 ? ` (incl. ${plural(r.impliedCount, "root valve")} from the legend)` : "";
      // Said from the ISO's side: the P&ID is the reference it is held to.
      const problem = r.status === "count mismatch" || r.status === "iso only" ? `ISO has ${r.isoCount}${legend}` : `Missing from BOM${legend}`;

      const total = totals.get(`${r.category}|${r.size}`)!;
      let note: string | null = null;
      if (INSTRUMENT.test(component)) {
        note = "Instruments are named differently on each drawing. See hook-up.";
      } else if (total.iso === total.accounted) {
        note = `Total matches (${total.iso}), only the class differs.`;
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
    }
    // An instrument no typical covers is PENDING client/vendor data, not an
    // issue -- see hookupPending.
  }
  return out;
}

/** Instruments the hook-up check could not cover: pending data from the client. */
function hookupPending(drawing: NonNullable<LineSummary["hookup"]>["drawings"][number] | undefined): PendingNote[] {
  if (!drawing) return [];
  const { sheetByPage } = drawing.verification;
  return drawing.verification.results
    .filter((r) => !r.sheet)
    .map((r) => ({
      sheet: r.isoPage != null ? (sheetByPage[r.isoPage] ?? `page ${r.isoPage}`) : "?",
      status: "vendor" as const,
      what: `Instrument ${r.instrumentTag}`,
      remark: instrumentPendingRemark(r.instrumentLabel, r.noTypicalReason),
      markedBy: null,
    }));
}

function spoolingIssues(sheets: NonNullable<LineSummary["spooling"]>["docs"][number]["sheets"] | undefined): SpoolingIssue[] {
  if (!sheets) return [];
  const out: SpoolingIssue[] = [];
  for (const sheet of sheets) {
    const label = sheet.sheetLabel || (sheet.page != null ? `page ${sheet.page}` : "?");
    for (const group of sheet.weldsBySpool) {
      for (const w of group.welds) {
        if (w.spoolOf === "-") {
          out.push({ sheet: label, weld: w.weldNo, weldType: w.weldType, size: w.size, problem: "No spool", drawingSpool: null });
        } else if (w.drawingSpool && w.drawingSpool !== w.spoolOf) {
          out.push({
            sheet: label,
            weld: w.weldNo,
            weldType: w.weldType,
            size: w.size,
            problem: `Filed under spool ${w.spoolOf}`,
            drawingSpool: w.drawingSpool,
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
    const allowance = s.fieldWelds > 0 ? ` (incl. 150 mm per field weld × ${s.fieldWelds})` : "";
    if (!fit || !s.envelope) {
      out.push({
        sheet,
        spool: s.spoolNo,
        size: "not read",
        problem: "Size not readable, fit not checked",
        note: "Not a drawing fault.",
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
          problem: `Fits with only ${best.tightestMm} mm to spare${allowance}`,
          note: "Heads-up only.",
        });
      }
      continue;
    }
    const close = nearMiss(fit);
    out.push({
      sheet,
      spool: s.spoolNo,
      size,
      problem: close ? `Too long by ${close.shortfallMm} mm${allowance}` : `Does not fit${allowance}`,
      note: close ? "Near miss: containers vary by this much." : null,
    });
  }
  // Errors first.
  return out.sort((a, b) => Number(a.note != null) - Number(b.note != null));
}

// ---------------------------------------------------------------------------
// One shape for every finding: ITEM, REQUIREMENT, DISCREPANCY, REQUIRED ACTION.
//
// Each check grew its own table -- "drawing says / line list says", "problem",
// "required by the typical, not found" -- so a designer had to learn six layouts
// and work out for themselves what to do about each row. Every section is now
// read the same way: what the item is, what the reference requires, what is wrong
// on the ISO, and who does what about it.
// ---------------------------------------------------------------------------

export interface Finding {
  /** The thing the finding is about: a field, a BOM row, a component, a weld, a spool. */
  item: string;
  /** Context under the item: sheet, class, size, quantity. */
  itemDetail: string | null;
  /** The item's description, one entry per item where the drawing lists several under one ID. */
  itemParts?: string[];
  /** What the reference document requires. */
  requirement: string;
  /** What is wrong on the ISO. */
  discrepancy: string;
  /** Who does what about it. Null on a finding for information. */
  action: string | null;
  /** Set on a finding that is shown but is not an error; says why. */
  info: string | null;
}

export interface ReportSection {
  title: string;
  /** The master document the ISO is checked against, where there is one. */
  reference: string | null;
  findings: Finding[];
}

// Fixes are the piping designer's unless they say "Checker:" -- the section
// header says so once, rather than every row starting "Piping designer to".

function designBasisFindings(issues: DesignBasisIssue[]): Finding[] {
  return issues.map((r) => ({
    item: r.field,
    itemDetail: null,
    requirement: r.pll,
    discrepancy: r.iso === "-" ? "Missing on ISO" : `ISO has ${r.iso}`,
    action: `${r.iso === "-" ? "Add" : "Change to"} ${r.pll}`,
    info: null,
  }));
}

function bomFindings(issues: BomIssue[]): Finding[] {
  return issues.map((r) => ({
    item: `Item ${r.itemNo}`,
    itemParts: r.parts,
    itemDetail: `Sheet ${r.sheet} · ${r.specClass} · ${r.size} · qty ${r.quantity}`,
    requirement: r.kind === "notChecked" ? "-" : r.kind === "wrongSpec" ? `${r.specClass} spec item` : (r.adminLine ?? `Listed in ${r.specClass}`),
    discrepancy: r.problem,
    action: r.kind === "notChecked" ? null : r.action,
    info: r.kind === "notChecked" ? "Not checked against the spec." : null,
  }));
}

function routingFindings(issues: RoutingIssue[]): Finding[] {
  return issues.map((r) => ({
    item: r.field,
    itemDetail: null,
    requirement: r.pid === "-" ? "Not on P&ID" : r.pid,
    discrepancy: `ISO has ${r.iso}`,
    action: r.pid === "-" ? "Remove, or confirm with P&ID" : `Change to ${r.pid}`,
    info: null,
  }));
}

function fittingFindings(issues: FittingIssue[]): Finding[] {
  return issues.map((r) => ({
    item: r.component,
    itemDetail: `${r.size} · ${r.specClass}`,
    requirement: r.pidCount > 0 ? `${r.pidCount}` : "None on P&ID",
    discrepancy: r.problem,
    action: r.note
      ? null
      : r.isoCount === 0
        ? `Add ${r.pidCount} to BOM`
        : r.pidCount === 0
          ? "Remove, or confirm with P&ID"
          : `Change to ${r.pidCount}`,
    info: r.note,
  }));
}

function hookupFindings(issues: HookupIssue[]): Finding[] {
  return issues.flatMap((h) => {
    const missing = h.missing.length > 0 ? h.missing : [{ item: "-", description: "Piping-scope items", size: "-", quantity: "-" }];
    return missing.map((m) => ({
      item: `${h.instrument} (${h.label})`,
      itemDetail: null,
      requirement: `${m.description}${m.size !== "-" ? `, ${m.size}` : ""}${m.quantity !== "-" ? ` × ${m.quantity}` : ""}`,
      discrepancy: "Missing on ISO",
      action: "Add to ISO",
      info: null,
    }));
  });
}

function spoolingFindings(issues: SpoolingIssue[]): Finding[] {
  return issues.map((r) => ({
    item: `Weld ${r.weld}`,
    itemDetail: `Sheet ${r.sheet} · ${r.weldType} · ${r.size}`,
    requirement: r.drawingSpool ? `Spool ${r.drawingSpool}` : "In a spool",
    discrepancy: r.problem,
    // Not a drawing fault: the spool a weld is stored under is this app's
    // reading, so it is the checker who puts it right.
    action: r.drawingSpool ? `Checker: move to spool ${r.drawingSpool}` : "Checker: assign a spool",
    info: null,
  }));
}

function containerFindings(issues: ContainerIssue[]): Finding[] {
  return issues.map((r) => ({
    item: `Spool ${r.spool}`,
    itemDetail: `Sheet ${r.sheet} · ${r.size}`,
    requirement: "Fits a 20ft container",
    discrepancy: r.problem,
    action: r.size === "not read" ? null : r.note ? "Checker: measure the container" : "Re-cut the spool",
    info: r.note,
  }));
}

/** A drawing's findings, section by section, every one in the same four parts. Empty sections are left out. */
export function reportSections(d: DrawingReport): ReportSection[] {
  return [
    { title: "Design basis vs line list", reference: "line list (PLL)", findings: designBasisFindings(d.designBasis.issues) },
    { title: "BOM vs admin spec", reference: "admin spec", findings: bomFindings(d.bom) },
    { title: "ISO vs P&ID", reference: "P&ID", findings: [...routingFindings(d.routing), ...fittingFindings(d.fittings)] },
    { title: "Instrument hook-up", reference: "hook-up typical", findings: hookupFindings(d.hookup) },
    { title: "Spooling", reference: null, findings: spoolingFindings(d.spooling) },
    { title: "Container check (20ft)", reference: null, findings: containerFindings(d.containers) },
  ].filter((s) => s.findings.length > 0);
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
    // Sheet by sheet, in sheet order, so "sheet 4" reads in one place.
    const pending = [...(d.mto.available ? bomPending(d.mto.sheetData) : []), ...hookupPending(hookupDrawing)].sort((a, b) =>
      a.sheet.localeCompare(b.sheet, undefined, { numeric: true })
    );

    const notChecked: string[] = [];
    const clear: string[] = [];

    if (d.pll.state === "none") notChecked.push("Line list: none uploaded");
    else if (d.pll.state === "notFound") notChecked.push("Line list: this line is not in it");
    else if (designBasis.issues.length === 0) clear.push("Line list");

    if (!d.mto.available) notChecked.push("Admin spec: none uploaded");
    else if (bomErrors === 0) clear.push("BOM");

    if (d.pid.state === "none") notChecked.push("P&ID: none uploaded");
    else if (d.pid.state === "notFound") notChecked.push("P&ID: this line is not on any");
    else if (routing.length === 0 && fittings.length === 0) clear.push("P&ID");

    // With no typicals at all the instruments are still listed, as Pending Vendor
    // Data -- so "not checked" is only said where there is nothing to list.
    if (!summary.hookup) notChecked.push("Hook-up: could not run");
    else if (!hookupDrawing || hookupDrawing.verification.results.length === 0) notChecked.push("Hook-up: no instruments in the BOM");
    else if (hookup.length === 0 && !pending.some((p) => p.what.startsWith("Instrument "))) clear.push("Hook-up");

    if (!summary.spooling || !spoolDoc) notChecked.push("Spooling: no spool data");
    else if (spooling.length === 0) clear.push("Spooling");

    if (!summary.containers || !containerDoc) notChecked.push("Container: no spools read");
    else if (containers.length === 0) clear.push("Container");

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
      pending,
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
    pending: sum((d) => d.pending.length),
  };
  return { drawings, totals };
}
