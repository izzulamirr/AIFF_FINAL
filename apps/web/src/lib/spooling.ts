// Turns a document's extracted tags into the per-sheet spool/weld view.
//
// This used to live inside the ISO document page, as one tab among its
// cross-document checks. It is its own thing: spooling is what a fabricator
// works from, it is read off the drawing rather than compared against another
// document, and it is the part still being corrected. Keeping it here means
// the /spooling page owns it and the ISO page does not have to load or build
// it at all.

import { normalizeTagNumber } from "@easy/shared";

/** The shape this needs off an extracted_tags row; anything wider also fits. */
export interface SpoolingTag {
  id: number;
  tagType: string;
  tagNumber: string;
  sourcePage: number | null;
  attributes: unknown;
}

export interface SpoolWeld {
  id: number;
  weldNo: string;
  weldType: string;
  size: string;
  ndeCodes: string;
  /** The spool this weld is stored under. */
  spoolOf: string;
  /**
   * Which spool the DRAWING puts this weld in -- the boundaries read off it
   * geometrically (bolted joints on the run, plus the field welds in the weld
   * list). Null on a sheet whose boundaries could not be established, which is
   * the honest answer rather than a guess.
   */
  drawingSpool: string | null;
  /**
   * What the vision extraction had recorded before the drawing's answer was
   * promoted to spool_no. Present only on welds that actually moved, so it is
   * the audit trail for a correction.
   */
  spoolWas: string | null;
}

export interface SpoolRow {
  id: number;
  spoolNo: string;
  weldCount: number;
  note: string;
}

export interface SpoolSheet {
  lineNumber: string;
  sheetLabel: string;
  page: number | null;
  spools: SpoolRow[];
  /** Welds grouped under the spool they sit in; "-" holds any whose spool is unknown. */
  weldsBySpool: Array<{ spoolNo: string; welds: SpoolWeld[] }>;
}

const UNASSIGNED = "-";

export function buildSpoolSheets(tags: SpoolingTag[]): SpoolSheet[] {
  const lines = tags.filter((t) => t.tagType === "line");

  return lines
    .slice()
    .sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0))
    .map((line): SpoolSheet | null => {
      const lineAttrs = line.attributes as Record<string, unknown>;
      const norm = normalizeTagNumber(line.tagNumber);
      // A multi-sheet ISO repeats its line number on every sheet, so a tag
      // belongs to this block only if it is on this SHEET as well as this line.
      const onThisSheet = (t: SpoolingTag) => {
        if (line.sourcePage != null && t.sourcePage !== line.sourcePage) return false;
        const ln = (t.attributes as Record<string, unknown>).line_number;
        return typeof ln === "string" && normalizeTagNumber(ln) === norm;
      };

      const spools = tags
        .filter((t) => t.tagType === "spool" && onThisSheet(t))
        .map((t) => {
          const a = t.attributes as Record<string, unknown>;
          const weldNumbers = Array.isArray(a.weld_numbers) ? a.weld_numbers : [];
          return {
            id: t.id,
            spoolNo: t.tagNumber,
            spoolIndex: Number(a.spool_index ?? 0),
            weldCount: weldNumbers.length,
            note: String(a.note ?? ""),
          };
        })
        // Read in the sheet's own printed schedule order.
        .sort((x, y) => x.spoolIndex - y.spoolIndex);

      const bySpool = new Map<string, SpoolWeld[]>();
      for (const t of tags.filter((t) => t.tagType === "weld" && onThisSheet(t))) {
        const a = t.attributes as Record<string, unknown>;
        const spoolNo = String(a.spool_no ?? UNASSIGNED);
        const list = bySpool.get(spoolNo) ?? [];
        list.push({
          id: t.id,
          weldNo: String(a.weld_no ?? ""),
          weldType: String(a.weld_type ?? "-"),
          size: String(a.size ?? "-"),
          ndeCodes: String(a.nde_codes ?? ""),
          spoolOf: spoolNo,
          drawingSpool: a.geometry_spool == null ? null : String(a.geometry_spool),
          spoolWas: a.spool_no_vision == null ? null : String(a.spool_no_vision),
        });
        bySpool.set(spoolNo, list);
      }

      const weldsBySpool = [...bySpool.entries()]
        .sort(([a], [b]) => {
          if (a === UNASSIGNED) return 1;
          if (b === UNASSIGNED) return -1;
          return a.localeCompare(b, undefined, { numeric: true });
        })
        .map(([spoolNo, welds]) => ({
          spoolNo,
          welds: welds.slice().sort((x, y) => x.weldNo.localeCompare(y.weldNo, undefined, { numeric: true })),
        }));

      if (spools.length === 0 && weldsBySpool.length === 0) return null;
      const sheetLabel =
        typeof lineAttrs.sheet === "string" && lineAttrs.sheet
          ? lineAttrs.sheet
          : line.sourcePage != null
            ? `page ${line.sourcePage}`
            : "";
      return { lineNumber: line.tagNumber, sheetLabel, page: line.sourcePage, spools, weldsBySpool };
    })
    .filter((v): v is SpoolSheet => v !== null);
}

/** Headline counts for a set of sheets, for the page's summary line. */
export function spoolingTotals(sheets: SpoolSheet[]) {
  const welds = sheets.flatMap((s) => s.weldsBySpool.flatMap((g) => g.welds));
  return {
    sheets: sheets.length,
    spools: sheets.reduce((n, s) => n + s.spools.length, 0),
    welds: welds.length,
    fromDrawing: welds.filter((w) => w.drawingSpool).length,
    disagreeing: welds.filter((w) => w.drawingSpool && w.drawingSpool !== w.spoolOf).length,
    corrected: welds.filter((w) => w.spoolWas && w.spoolWas !== w.spoolOf).length,
    unassigned: welds.filter((w) => w.spoolOf === UNASSIGNED).length,
  };
}
