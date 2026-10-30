// Turns an ISO's extracted tags into the per-sheet PIPE SUPPORT view.
//
// Its own page, for the same reason spooling has one. Support adequacy used
// to be "gate 6" of the cross-document ISO compile, where it did two string
// checks -- does the BOM row name a support type at all, and does that type
// appear on the GA -- and neither is the question anyone has about supports.
// The question is WHETHER THE PIPE IS HELD UP OFTEN ENOUGH, which is read off
// one drawing: the supports it calls for, the distances it prints, and the
// project's span sheet.
//
// WHERE THE ROWS COME FROM, because this is the part that was wrong before.
// `pipe_support` rows are written by `packages/db/scripts/import-pipe-supports.mjs`
// from what `apps/worker/scripts/export-pipe-supports.ts` finds GEOMETRICALLY
// -- the item balloon, its leader onto the run, and the BOM row the balloon's
// number names. Nothing here reads a figure a model wrote in prose. The
// earlier version of this data had the same support carrying four different
// span lengths across four extractions of one drawing, which is what a
// measurement taken by eye off a not-to-scale drawing looks like.

import {
  checkSpan,
  configurationsFromDirections,
  findSpanStandard,
  supportsRequired,
  materialFamily,
  npsInchOf,
  scheduleOf,
  VERTICAL_DIRECTIONS,
  type SpanConfiguration,
  type SpanVerdict,
} from "@easy/shared";
import type { SpoolingTag } from "./spooling";

/** A support the sheet's BOM calls for -- the count is the reliable part. */
export interface SupportItem {
  itemNo: string | null;
  description: string;
  /** SC101, RB103 -- the project's support type designation. */
  typeCode: string | null;
  role: "primary" | "secondary" | "unstated";
  size: string | null;
  quantity: number;
}

/** A measured stretch of pipe, judged against the span sheet. */
export interface SupportSpan {
  /**
   * A gap BETWEEN two supports, or the pipe from one to the END of the
   * dimensioned run.
   *
   * The gaps between supports are not the whole question -- a run has two
   * ends, and the pipe past the last support is unsupported just the same.
   * A run-end is REPORTED, not failed: the end of a dimension chain can be
   * an anchor, an equipment nozzle, a dead end, or where the line carries on
   * to the next sheet, and what holds it there is usually not on this
   * drawing.
   */
  kind: "span" | "run-end";
  toSupport: string;
  lengthMm: number | null;
  /** The printed dimensions this span is made of -- the workings. */
  legs: string[];
  configurations: SpanConfiguration[];
  verticalLegMm: number | null;
  verdict: SpanVerdict;
}

export interface SupportPoint {
  /** The balloon's cell on the contact sheet -- names it and indexes its label. */
  cell: string;
  itemNo: string | null;
  description: string | null;
  typeCode: string | null;
  role: "primary" | "secondary" | "unstated";
  spans: SupportSpan[];
}

export interface SupportSheet {
  key: string;
  page: number | null;
  sheetLabel: string;
  lineNumber: string | null;
  /** What the span standard was chosen on, and where each part came from. */
  npsInch: number | null;
  schedule: string | null;
  material: string | null;
  basis: string[];
  items: SupportItem[];
  points: SupportPoint[];
  /** Supports the BOM calls for, less the ones found on the drawing. */
  unlocated: number;
  /**
   * Pipe on this sheet, in mm, from its own BOM. The sheet's own scale of
   * the problem: a sheet with no supports and 400mm of pipe is a different
   * thing from one with no supports and 30 metres.
   */
  pipeMm: number;
  /**
   * How many supports this sheet needs and has NOT got, at the straight-run
   * limit for its pipe. Only meaningful where the sheet carries no supports
   * at all -- where it has some, the per-span verdicts are the answer.
   *
   * A LOWER BOUND: the pipe figure is the sheet's total, and several
   * separate runs each need their own supports, so the true number can only
   * be higher. The page says "at least".
   */
  missingSupports: number;
  /**
   * Whether a span sheet was found for this pipe at all.
   *
   * Distinct from missingSupports being zero. A sheet with no standard
   * cannot require anything, and reporting that as "short enough" turns an
   * unchecked sheet into a passing one -- which is the one thing this page
   * must never do.
   */
  standardFound: boolean;
  /**
   * Why this sheet has no spans, where they were deliberately withheld.
   *
   * A span is the gap between two CONSECUTIVE supports, and consecutive is
   * only knowable once they have all been found -- so an incomplete read
   * yields no spans at all rather than spans that merge the two gaps either
   * side of whatever was missed. "None measured" and "none to measure" are
   * different answers and the page must not show them the same way.
   */
  spansWithheld: string | null;
  overCount: number;
  uncheckedCount: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
}

/**
 * The support's catalogue designation -- SC101, RB103, SW100.
 *
 * Letters then digits with no hyphen, which is what the project's support
 * standard uses. Deliberately not the ISA tag shape: a support is not an
 * instrument, and the two patterns would otherwise read each other's codes.
 */
export function supportTypeCode(text: unknown): string | null {
  const m = String(text ?? "").toUpperCase().match(/\b([A-Z]{2,3}\d{2,4})\b/);
  return m ? m[1] : null;
}

/**
 * A BOM row that is PIPE, and not a pipe support.
 *
 * "PIPE SUPPORT" contains the word pipe, word boundaries and all, so the
 * obvious test counts every support as pipe -- which both inflates the
 * length the sheet has to hold up and lets a support's own size decide which
 * span sheet applies.
 */
function isPipeRow(row: Record<string, unknown>): boolean {
  const t = String(row.component_type ?? "").toLowerCase();
  return /\bpipe\b/.test(t) && !/support/.test(t);
}

function roleOf(text: unknown): "primary" | "secondary" | "unstated" {
  const t = String(text ?? "").toLowerCase();
  if (/\bprimary\b/.test(t)) return "primary";
  if (/\bsecondary\b/.test(t)) return "secondary";
  return "unstated";
}

/**
 * One leg of a span, as the container check already knows it.
 *
 * THE SPAN'S LENGTHS ARE THE CONTAINER CHECK'S LENGTHS. Both are the printed
 * dimensions read off the sheet, keyed by the same contact-sheet cell, so
 * there is no second reading of the drawing here and no second place for one
 * to go stale. `buildSpoolEnvelopes` already resolved every cell to
 * millimetres AND to a plant direction; this reads that back.
 */
export interface SpanLeg {
  cell: string;
  mm: number;
  /** E, W, N, S, UP or DOWN -- which way the pipe actually runs. */
  direction: string;
}

/**
 * Every printed length on a sheet, from the spool envelopes stored on it.
 *
 * Prefers `printedMm` over `mm` where the two differ. They differ when a
 * length runs past the weld that closes its spool, and `mm` is then the
 * SPOOL'S SHARE -- but a support span does not care where a spool ends. The
 * pipe is continuous once erected, so the length between two supports is the
 * whole printed figure, not the part belonging to one side of a field weld.
 */
export function printedLengths(tags: SpoolingTag[]): Map<string, SpanLeg> {
  const out = new Map<string, SpanLeg>();
  for (const tag of tags) {
    if (tag.tagType !== "spool") continue;
    const envelope = (tag.attributes as Record<string, unknown>)?.envelope as
      | { parts?: Record<string, Array<Record<string, unknown>>> }
      | undefined;
    for (const parts of Object.values(envelope?.parts ?? {})) {
      for (const part of parts) {
        const cell = str(part.cell);
        const mm = num(part.printedMm) ?? num(part.mm);
        if (!cell || mm == null) continue;
        out.set(cell, { cell, mm, direction: String(part.drawnAs ?? "") });
      }
    }
  }
  return out;
}

/**
 * The pipe the span sheet is chosen for.
 *
 * Size, schedule and material all off the largest PIPE row in the sheet's own
 * BOM -- the main run. Taken from the pipe rather than from a valve, whose
 * body is a different material in the same BOM and whose size is its own.
 */
function pipeOf(bom: Array<Record<string, unknown>>): {
  npsInch: number | null;
  schedule: string | null;
  material: string | null;
  basis: string[];
} {
  const pipes = bom.filter(isPipeRow);
  let best: { nps: number; row: Record<string, unknown> } | null = null;
  for (const row of pipes) {
    const size = typeof row.size === "string" || typeof row.size === "number" ? row.size : null;
    const nps = npsInchOf(size);
    if (nps != null && (!best || nps > best.nps)) best = { nps, row };
  }
  if (!best) return { npsInch: null, schedule: null, material: null, basis: ["no PIPE row in this sheet's BOM to take a size from"] };

  const text = String(best.row.description ?? "");
  const schedule = scheduleOf(text);
  const material = materialFamily(text);
  return {
    npsInch: best.nps,
    schedule,
    material,
    basis: [
      `${best.nps}" NPS from the largest PIPE row on the sheet (DN ${String(best.row.size ?? "?")})`,
      schedule ? `Sch-${schedule} from that row's description` : "no schedule stated on that row",
      material ? `${material} from that row's material callout` : "material not recognised on that row",
    ],
  };
}

/**
 * Build the support view for one document's tags.
 *
 * A sheet with neither support BOM rows nor located supports is left out: a
 * page listing every sheet and saying "nothing here" on most of them buries
 * the ones that matter.
 */
export function buildSupportSheets(tags: SpoolingTag[]): SupportSheet[] {
  const pages = [...new Set(tags.map((t) => t.sourcePage))].sort((a, b) => (a ?? 0) - (b ?? 0));
  const total = pages.length;
  const sheets: SupportSheet[] = [];

  for (const page of pages) {
    const onPage = tags.filter((t) => t.sourcePage === page);
    const bom = onPage.filter((t) => t.tagType === "bom_item").map((t) => t.attributes as Record<string, unknown>);

    const items: SupportItem[] = bom
      .filter((r) => /support/i.test(`${r.component_type ?? ""} ${r.description ?? ""}`))
      .map((r) => ({
        itemNo: str(r.item_no),
        description: String(r.description ?? ""),
        typeCode: supportTypeCode(r.description),
        role: roleOf(r.description ?? r.component_type),
        size: str(r.size),
        quantity: num(r.quantity) ?? 1,
      }));

    const supportTags = onPage.filter((t) => t.tagType === "pipe_support");

    // A SHEET WITH PIPE AND NO SUPPORTS IS THE FINDING, so it must not be
    // the row that gets skipped. Leaving these out is how a document whose
    // every span passes can have forty metres of unheld pipe and show a
    // clean page -- the sheets carrying it simply never appeared.
    const pipeMm = bom.filter(isPipeRow).reduce((n, r) => {
      // The BOM gives PIPE by the metre ("4.1M") and everything else by
      // count, so a row with no metre figure contributes nothing.
      const m = String(r.quantity ?? "").match(/([\d.]+)\s*m\b/i);
      return n + (m ? Number(m[1]) * 1000 : 0);
    }, 0);
    if (items.length === 0 && supportTags.length === 0 && pipeMm === 0) continue;

    // The same printed lengths the container check works from, keyed by the
    // same contact-sheet cell. One reading of the drawing, used twice.
    const printed = printedLengths(onPage);

    const { npsInch, schedule, material, basis } = pipeOf(bom);
    const lineNumber =
      str(bom.find((r) => r.line_number)?.line_number) ??
      onPage.find((t) => t.tagType === "line")?.tagNumber ??
      null;

    const points: SupportPoint[] = supportTags
      .map((tag) => {
        const a = tag.attributes as Record<string, unknown>;
        const spans = Array.isArray(a.spans) ? (a.spans as Array<Record<string, unknown>>) : [];
        return {
          cell: str(a.cell) ?? tag.tagNumber,
          itemNo: str(a.item_no),
          description: str(a.description),
          typeCode: str(a.type_code),
          role: roleOf(a.role ?? a.description),
          spans: spans.map((raw) => {
            const legCells = Array.isArray(raw.legs) ? (raw.legs as unknown[]).map(String) : [];
            const resolved = legCells.map((cell) => printed.get(cell) ?? null);

            // Prefer the container check's own lengths. They are the same
            // printed dimensions, read once, so taking them here means the
            // support page and the shipping page can never quote different
            // figures for one piece of pipe. The stored span_mm is the
            // fallback for a sheet whose envelopes were never built.
            const allResolved = resolved.length > 0 && resolved.every((l) => l != null);
            const lengthMm = allResolved ? resolved.reduce((n, l) => n + (l as SpanLeg).mm, 0) : num(raw.span_mm);

            const directions = resolved.filter((l): l is SpanLeg => l != null).map((l) => l.direction);
            const configurations = allResolved
              ? configurationsFromDirections(directions)
              : // No directions to read, so the shape is unknown: offer both
                // turn cases and let the shorter govern, which is what this
                // did everywhere before the envelopes were consulted.
                (num(raw.turns) ?? 0) > 0
                ? (["l-turn", "v-turn"] as SpanConfiguration[])
                : (["straight"] as SpanConfiguration[]);

            const verticalLegMm =
              resolved
                .filter((l): l is SpanLeg => l != null && VERTICAL_DIRECTIONS.has(l.direction.toUpperCase()))
                .reduce<number | null>((max, l) => (max == null || l.mm > max ? l.mm : max), null) ?? num(raw.vertical_leg_mm);
            return {
              kind: raw.kind === "run-end" ? ("run-end" as const) : ("span" as const),
              toSupport: str(raw.to_support) ?? "?",
              lengthMm,
              legs: legCells,
              configurations,
              verticalLegMm,
              // THE STANDARD IS APPLIED HERE. The stored row carries the
              // measurement and the shape; what that is allowed to be is the
              // span sheet's business, and keeping it in code means one place
              // to correct when the sheet is reissued.
              verdict:
                lengthMm == null || lengthMm <= 0
                  ? {
                      status: "no standard" as const,
                      maxSpanMm: null,
                      governing: null,
                      overByMm: null,
                      slackMm: null,
                      supportsRequired: 0,
                      verticalLegOverByMm: null,
                      basis:
                        "the printed lengths between these two supports were not all read, so the distance is not known",
                    }
                  : checkSpan({ lengthMm, configurations, verticalLegMm, npsInch, schedule, material }),
            };
          }),
        };
      })
      .sort((a, b) => a.cell.localeCompare(b.cell, undefined, { numeric: true }));

    const called = items.reduce((sum, i) => sum + i.quantity, 0);
    const standard = findSpanStandard({ npsInch, schedule, material });
    // Only where the sheet has NO supports at all. Where it has some, the
    // per-span verdicts already say which gap is too long, and a sheet-level
    // figure computed from total pipe would double-count them.
    const missingSupports =
      points.length === 0 && standard?.spans.straight ? supportsRequired(pipeMm, standard.spans.straight) : 0;
    const spansWithheld =
      points.map((p) => str((supportTags.find((t) => (t.attributes as Record<string, unknown>).cell === p.cell)?.attributes as Record<string, unknown> | undefined)?.spans_withheld)).find((v) => v != null) ?? null;
    const spans = points.flatMap((p) => p.spans);
    sheets.push({
      key: `${page ?? "?"}`,
      page,
      sheetLabel: `${page ?? "?"} / ${total}`,
      lineNumber,
      npsInch,
      schedule,
      material,
      basis,
      items,
      points,
      unlocated: Math.max(0, called - points.length),
      pipeMm,
      missingSupports,
      standardFound: standard != null,
      spansWithheld,
      overCount: spans.filter((s) => s.verdict.status === "over" || s.verdict.verticalLegOverByMm != null).length,
      uncheckedCount: spans.filter((s) => s.verdict.status === "no standard").length,
    });
  }

  return sheets;
}

export function supportTotals(sheets: SupportSheet[]) {
  const spans = sheets.flatMap((s) => s.points.flatMap((p) => p.spans));
  return {
    sheets: sheets.length,
    supports: sheets.reduce((n, s) => n + s.points.length, 0),
    called: sheets.reduce((n, s) => n + s.items.reduce((m, i) => m + i.quantity, 0), 0),
    // Each span is stored once, on the support it starts at, so these are
    // already distinct -- no de-duplication needed and none pretended.
    spans: spans.length,
    over: spans.filter((s) => s.verdict.status === "over").length,
    unchecked: spans.filter((s) => s.verdict.status === "no standard").length,
    unlocated: sheets.reduce((n, s) => n + s.unlocated, 0),
    // Supports the standard requires that the drawing does not show: the
    // per-span shortfalls, plus the sheets carrying pipe and nothing at all.
    required:
      spans.reduce((n, s) => n + s.verdict.supportsRequired, 0) + sheets.reduce((n, s) => n + s.missingSupports, 0),
  };
}

/**
 * What is wrong on a sheet, and what to do about it.
 *
 * A NUMBER IS NOT A FINDING. "2437mm" and "over by 1300" are both facts a
 * reader still has to act on, and the act is always the same shape: add this
 * many supports, no further apart than this. Leaving the division to whoever
 * opens the page is how a 30-metre unheld run gets read as one more amber
 * row. So every problem here carries its own fix.
 *
 * Ordered worst first, because the top of the list is what gets read.
 */
export interface SupportProblem {
  /** "error" is a breach of the standard; "check" needs a human to look. */
  severity: "error" | "check";
  what: string;
  fix: string;
}

export function supportProblems(sheet: SupportSheet): SupportProblem[] {
  const out: SupportProblem[] = [];
  const metres = (mm: number) => `${(mm / 1000).toFixed(1)} m`;

  // The biggest one: pipe on the sheet and nothing holding it.
  if (sheet.points.length === 0 && sheet.pipeMm > 0) {
    if (sheet.missingSupports > 0) {
      out.push({
        severity: "error",
        what: `No supports on this sheet (${metres(sheet.pipeMm)} of pipe).`,
        fix: `Add at least ${sheet.missingSupports} support${sheet.missingSupports === 1 ? "" : "s"}.`,
      });
    } else if (!sheet.standardFound) {
      // NOT "short enough". No standard means nothing was checked, and an
      // unchecked sheet reported as adequate is the worst thing this page
      // could say.
      const pipe = [
        sheet.npsInch != null ? `${sheet.npsInch}"` : "an unknown size",
        sheet.schedule ? `Sch-${sheet.schedule}` : "an unknown schedule",
        sheet.material ?? "an unknown material",
      ].join(" ");
      out.push({
        severity: "check",
        what: `No supports on this sheet (${metres(sheet.pipeMm)} of pipe). Not checked: there is no span standard for ${pipe}.`,
        fix: `Provide the span standard for ${pipe}.`,
      });
    } else {
      out.push({
        severity: "check",
        what: `No supports on this sheet (${metres(sheet.pipeMm)} of pipe).`,
        fix: "Probably short enough to need none. Confirm what holds each end.",
      });
    }
  }

  for (const point of sheet.points) {
    for (const span of point.spans) {
      // "S" for a support balloon, matching the table. Without it these read
      // as bare "1-8", which on this drawing is also a dimension cell.
      const where = span.kind === "run-end" ? `S${point.cell} to the end of the run` : `S${point.cell} to S${span.toSupport}`;

      if (span.verdict.status === "over" && span.verdict.supportsRequired > 0) {
        out.push({
          severity: "error",
          what: `Gap ${where} is ${span.lengthMm} mm. Maximum allowed is ${span.verdict.maxSpanMm} mm.`,
          fix: `Add ${span.verdict.supportsRequired} support${span.verdict.supportsRequired === 1 ? "" : "s"} in this gap.`,
        });
      }

      if (span.verdict.verticalLegOverByMm != null) {
        out.push({
          severity: "check",
          what: `Vertical leg ${where} is ${span.verticalLegMm} mm. Maximum for a hanging leg is 1100 mm.`,
          fix: "Add a support at the bottom of the leg, or confirm it is supported from above.",
        });
      }

      if (span.verdict.status === "no standard" && span.lengthMm != null) {
        out.push({
          severity: "check",
          what: `Gap ${where} is ${span.lengthMm} mm. Not checked: ${span.verdict.basis}.`,
          fix: "Provide the span standard for this pipe.",
        });
      }
    }
  }

  if (sheet.spansWithheld) {
    out.push({
      severity: "check",
      what: `Gaps on this sheet not measured. ${sheet.spansWithheld}`,
      fix: "Find the missing support on the drawing, or correct its tag reading.",
    });
  } else if (sheet.unlocated > 0) {
    out.push({
      severity: "check",
      what: `${sheet.unlocated} support${sheet.unlocated === 1 ? "" : "s"} in the BOM not found on the drawing.`,
      fix: "Check the support tags on the drawing.",
    });
  }

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}
