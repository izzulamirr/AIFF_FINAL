// Reads a client spec's pipe table by GEOMETRY instead of by asking a model which
// size columns a merged cell covers.
//
// A spec's pipe table has a header row of sizes and, under it, rows such as Schedule,
// Ends and Mat'l Specification. A value is usually one cell that SPANS several size
// columns -- "80" over 2 and 3 -- drawn by leaving out the vertical rules between them.
// Read as flattened text, "80" reads the same wherever it was drawn, so which columns it
// covers has to be guessed, and on a long row the guess slips by a column or two. But the
// page is vector: every rule and every word has coordinates. The cell a word sits in is
// the gap between the vertical rules either side of it on ITS row, and the sizes it covers
// are the header columns lying inside that gap. Nothing is inferred.
//
// Pure functions over positioned text and ruling segments, so it is testable without a PDF.
import { parseNpsInches, repairInvertedSizeRange } from "@easy/shared";

export interface TextItem {
  str: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A drawn horizontal ("H", `a` is y) or vertical ("V", `a` is x) rule, spanning b0..b1. */
export interface RuleSeg {
  kind: "H" | "V";
  a: number;
  b0: number;
  b1: number;
}

export interface SizeColumn {
  label: string;
  /** For a range column such as "26-30". Equal for a single size. */
  min: string;
  max: string;
  cx: number;
}

export interface TableCell {
  text: string;
  /** The size columns this cell covers, in order. */
  columns: SizeColumn[];
  x0: number;
  x1: number;
}

export interface TableRow {
  label: string;
  y0: number;
  y1: number;
  cells: TableCell[];
}

export interface SpecTable {
  columns: SizeColumn[];
  rows: TableRow[];
}

const SIZE_TOKEN = String.raw`\d+(?:\s\d+\/\d+|\/\d+)?`;
const SIZE_CELL = new RegExp(`^${SIZE_TOKEN}(?:\\s*[-–]\\s*${SIZE_TOKEN})?$`);

const cy = (i: { y0: number; y1: number }) => (i.y0 + i.y1) / 2;
const cx = (i: { x0: number; x1: number }) => (i.x0 + i.x1) / 2;

/** Merge rules at (nearly) the same coordinate into one. */
function dedupe(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  let group: number[] = [];
  for (const v of sorted) {
    if (group.length > 0 && v - group[group.length - 1] > tol) {
      out.push(group.reduce((s, g) => s + g, 0) / group.length);
      group = [];
    }
    group.push(v);
  }
  if (group.length > 0) out.push(group.reduce((s, g) => s + g, 0) / group.length);
  return out;
}

/** True when the pieces of horizontal rules at this y together span [x0, x1]. */
function spans(segs: RuleSeg[], y: number, x0: number, x1: number, tol = 1.2): boolean {
  const pieces = segs
    .filter((s) => s.kind === "H" && Math.abs(s.a - y) <= tol)
    .map((s) => [s.b0, s.b1] as const)
    .sort((a, b) => a[0] - b[0]);
  let reach = -Infinity;
  for (const [a, b] of pieces) {
    if (reach === -Infinity) reach = b;
    else if (a <= reach + 2) reach = Math.max(reach, b);
    else if (reach >= x1 - 3) break;
    else reach = b;
    if (reach >= x1 - 3 && pieces[0][0] <= x0 + 3) return true;
  }
  return pieces.length > 0 && pieces[0][0] <= x0 + 3 && reach >= x1 - 3;
}

export function readSpecTable(items: TextItem[], segs: RuleSeg[]): SpecTable | null {
  // The header is the "SIZE" label whose own row holds the size columns. A page can print
  // another "Size ..." heading elsewhere ("Size Range (NPS)"), so take the label with the
  // most sizes beside it rather than the first.
  const sizesBeside = (h: TextItem) =>
    items
      .filter((i) => Math.abs(cy(i) - cy(h)) <= 4 && i.x0 > h.x1 && SIZE_CELL.test(i.str.trim()))
      .sort((a, b) => a.x0 - b.x0);
  const candidates = items.filter((i) => /^SIZE\b/i.test(i.str)).map((h) => ({ h, sizes: sizesBeside(h) }));
  candidates.sort((a, b) => b.sizes.length - a.sizes.length);
  const best = candidates[0];
  if (!best || best.sizes.length < 3) return null;
  const header = best.h;
  const yc = cy(header);

  // ---- the size columns: header-row words that read as a size or a size range.
  const sizeItems = best.sizes;

  // Vertical rules that cross the header row are the column edges.
  const headerRules = dedupe(
    segs.filter((s) => s.kind === "V" && s.b0 <= yc + 1 && s.b1 >= yc - 1).map((s) => s.a),
    1.5
  );
  const columns: SizeColumn[] = sizeItems.map((it) => {
    const parts = it.str.trim().split(/\s*[-–]\s*/);
    // "1-1/2" is one and a half inches, not a range from 1 to 1/2 -- the same repair the
    // model's own output gets (a range only ever ascends).
    const { size_min, size_max } = repairInvertedSizeRange(parts[0], parts[parts.length - 1]);
    return { label: it.str.trim(), min: String(size_min), max: String(size_max), cx: cx(it) };
  });
  const left = Math.min(...sizeItems.map((i) => i.x0)) - 4;
  const edgeLeft = headerRules.filter((r) => r <= left + 6).pop() ?? left;
  const lastItem = sizeItems[sizeItems.length - 1];
  const edgeRight = headerRules.find((r) => r >= lastItem.x1 - 1) ?? lastItem.x1 + 4;

  // ---- row bands: horizontal rules that run the whole width of the size columns.
  const headerBottom = Math.max(header.y1, ...sizeItems.map((i) => i.y1)) + 1;
  const ys = dedupe(
    segs.filter((s) => s.kind === "H" && s.a > headerBottom).map((s) => s.a),
    1.2
  ).filter((y) => spans(segs, y, edgeLeft, edgeRight));
  const bandTop = dedupe(segs.filter((s) => s.kind === "H" && s.a > yc && s.a < headerBottom + 6).map((s) => s.a), 1.2).filter((y) =>
    spans(segs, y, edgeLeft, edgeRight)
  );
  const edges = [...bandTop.slice(-1), ...ys].sort((a, b) => a - b);
  // Where the table itself starts: the left end of its row rules. A rule left of that is
  // page furniture, not the edge of the label column.
  const tableX0 = Math.min(
    ...segs.filter((s) => s.kind === "H" && edges.some((y) => Math.abs(s.a - y) <= 1.2)).map((s) => s.b0),
    edgeLeft
  );

  const rows: TableRow[] = [];
  const labelSpan: Array<{ labelLeft: number; top: number }> = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const top = edges[k];
    const bottom = edges[k + 1];
    if (bottom - top < 6) continue;
    const mid = (top + bottom) / 2;
    const inBand = items.filter((i) => cy(i) > top && cy(i) < bottom);

    // The row label: words in the label column, right of the group label's own rule (the
    // narrow column that says PIPE / FITTINGS / FLANGES down the side).
    const labelEdge =
      Math.max(
        ...segs.filter((s) => s.kind === "V" && s.a < edgeLeft - 15 && s.a > tableX0 + 3 && s.b0 <= mid && s.b1 >= mid).map((s) => s.a),
        -Infinity
      );
    const labelLeft = Number.isFinite(labelEdge) ? labelEdge : 55;
    const labelItems = inBand.filter((i) => i.x1 <= edgeLeft + 1 && i.x0 >= labelLeft - 1).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const label = labelItems.map((i) => i.str).join(" ").trim();

    // Vertical rules that cross this row's middle are ITS cell edges.
    const rowRules = dedupe(
      segs.filter((s) => s.kind === "V" && s.a >= edgeLeft - 2 && s.a <= edgeRight + 2 && s.b0 <= mid && s.b1 >= mid).map((s) => s.a),
      1.5
    );
    const bounds = [edgeLeft, ...rowRules.filter((r) => r > edgeLeft + 2 && r < edgeRight - 2), edgeRight];

    const cells = new Map<string, { items: TextItem[]; x0: number; x1: number }>();
    for (const it of inBand.filter((i) => i.x0 >= edgeLeft - 2 && i.x1 <= edgeRight + 40)) {
      const c = cx(it);
      let L = bounds[0];
      let R = bounds[bounds.length - 1];
      for (let b = 0; b + 1 < bounds.length; b++) {
        if (c >= bounds[b] && c <= bounds[b + 1]) {
          L = bounds[b];
          R = bounds[b + 1];
          break;
        }
      }
      // Text past the last size column belongs to the last cell.
      const key = `${L.toFixed(1)}|${R.toFixed(1)}`;
      const cell = cells.get(key) ?? { items: [], x0: L, x1: R };
      cell.items.push(it);
      cells.set(key, cell);
    }

    labelSpan.push({ labelLeft, top });
    rows.push({
      label,
      y0: top,
      y1: bottom,
      cells: [...cells.values()]
        .sort((a, b) => a.x0 - b.x0)
        .map((c) => ({
          text: c.items
            .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
            .map((i) => i.str)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
          columns: columns.filter((col) => col.cx > c.x0 && col.cx < c.x1),
          x0: c.x0,
          x1: c.x1,
        })),
    });
  }

  // A label can be one merged cell over several rows ("Flange" over its Class 150 and Class
  // 300 rows): where no rule crosses the label column between two rows they are one group,
  // and the label the group carries belongs to every row in it.
  for (let k = 0; k < rows.length; ) {
    let end = k + 1;
    while (end < rows.length && !spans(segs, rows[end].y0, labelSpan[end].labelLeft + 2, edgeLeft - 2)) end++;
    const label = rows
      .slice(k, end)
      .map((r) => r.label)
      .filter(Boolean)
      .join(" ")
      .trim();
    for (let j = k; j < end; j++) rows[j].label = label;
    k = end;
  }
  return { columns, rows };
}

export interface PipeBand {
  size_min: string;
  size_max: string;
  schedule?: string;
  end_type?: string;
  material?: string;
}

export interface PipeReading {
  /** One row per size column, in column order. */
  rows: PipeBand[];
  /** Why the table should not be trusted, if it should not. Empty when every column is covered once. */
  issues: string[];
}

const isRow = (row: TableRow, re: RegExp) => re.test(row.label);

/**
 * The pipe rows -- one per size column -- from a table's Schedule, Ends and Mat'l
 * Specification rows. Null where there is no Schedule row, which is not a pipe table.
 */
export function pipeRowsFromTable(table: SpecTable): PipeReading | null {
  const schedule = table.rows.find((r) => isRow(r, /^schedule/i));
  if (!schedule) return null;
  const ends = table.rows.find((r) => isRow(r, /^ends?\b/i));
  const material = table.rows.find((r) => isRow(r, /mat.?l|material/i) && !isRow(r, /^schedule/i));

  const issues: string[] = [];
  const valueAt = (row: TableRow | undefined, col: SizeColumn, what: string): string | undefined => {
    if (!row) return undefined;
    const hits = row.cells.filter((c) => c.text && c.columns.includes(col));
    if (hits.length === 0) {
      issues.push(`${what} has no value under ${col.label}.`);
      return undefined;
    }
    if (hits.length > 1) issues.push(`${what} has more than one value under ${col.label}.`);
    return hits[0].text;
  };

  const rows = table.columns.map((col): PipeBand => {
    const raw = valueAt(schedule, col, "Schedule");
    // A bare decimal in this row is a wall thickness in mm, not a schedule number.
    const sched = raw && /^\d+\.\d+$/.test(raw) ? `${raw}mm` : raw;
    return {
      size_min: col.min,
      size_max: col.max,
      ...(sched ? { schedule: sched } : {}),
      ...(ends ? { end_type: valueAt(ends, col, "Ends") } : {}),
      ...(material ? { material: valueAt(material, col, "Mat'l Specification") } : {}),
    };
  });

  // Sizes must ascend left to right, or the columns were misread.
  const inches = table.columns.map((c) => parseNpsInches(c.min));
  for (let i = 1; i < inches.length; i++) {
    const a = inches[i - 1];
    const b = inches[i];
    if (a != null && b != null && b < a) issues.push(`Size columns are not in ascending order at ${table.columns[i].label}.`);
  }
  return { rows, issues };
}

// ---- from the table's rows to a spec class's pipes / fittings / flanges -------------

const NOTE = /\(\s*notes?\b[^)]*\)/gi;
const cleanLabel = (label: string) => label.replace(NOTE, "").replace(/\s+/g, " ").trim();

const FITTING_LABEL = /cap|elbow|reducer|\btee|o.?let|weldolet|sockolet|threadolet|coupling|swage|nipple|bend|plug/i;
const FLANGE_LABEL = /flange|gasket|stud|bolt|spectacle|spade|orifice/i;
const END_TYPE = /\b(BW|SW|SCRD|THRD|WN|SO|LJ)\b/i;

/** One row of a fittings or flanges category, spanning the sizes its cell covers. */
export type BandRow = Record<string, unknown>;

export interface ClassTableRows {
  pipes: PipeBand[];
  fittings: BandRow[];
  flanges: BandRow[];
  /** Why the read should not be trusted, if it should not. Empty when it can be. */
  issues: string[];
}

/**
 * Pipes, fittings and flanges for one class, read from its table. Valves are not here: a
 * valve table has its own columns, and stays with the model.
 */
export function classRowsFromTable(table: SpecTable): ClassTableRows | null {
  const pipe = pipeRowsFromTable(table);
  if (!pipe) return null;

  const fittings: BandRow[] = [];
  const flanges: BandRow[] = [];
  let lastLabel = "";
  for (const row of table.rows) {
    // A second table further down the page (the valves) starts at its own header row.
    if (/^type$/i.test(row.label.trim())) break;
    const label = cleanLabel(row.label) || lastLabel;
    if (row.label.trim()) lastLabel = label;
    if (!label || /^(schedule|ends?|mat.?l)/i.test(label)) continue;

    for (const cell of row.cells) {
      if (!cell.text || cell.columns.length === 0) continue;
      const base: BandRow = {
        size_min: cell.columns[0].min,
        size_max: cell.columns[cell.columns.length - 1].max,
        material: cell.text,
        description: cell.text,
      };
      const end = END_TYPE.exec(cell.text)?.[1]?.toUpperCase();
      if (end) base.end_type = end;

      if (FLANGE_LABEL.test(label)) {
        const rating = /class\s*(\d{3,4})/i.exec(cell.text)?.[1];
        flanges.push({ flange_type: label, ...(rating ? { class: rating } : {}), ...base });
      } else if (FITTING_LABEL.test(label)) {
        fittings.push({ fitting_type: label, ...base });
      }
    }
  }
  return { pipes: pipe.rows, fittings, flanges, issues: pipe.issues };
}
