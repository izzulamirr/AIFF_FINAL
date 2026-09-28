// The PDF side of specTable.ts: turn one page into positioned text and ruling segments.
import { readPageGeometry } from "../pdfGeometry";
import { readTextItems } from "../pdfTextItems";
import { readSpecTable, type RuleSeg, type SpecTable } from "./specTable";

/** The page's horizontal and vertical rules, from the drawn line paths. */
export async function readRuleSegments(buffer: Buffer, page: number): Promise<RuleSeg[]> {
  const geom = await readPageGeometry(buffer, page);
  const segs: RuleSeg[] = [];
  for (const p of geom.paths) {
    for (let k = 0; k + 1 < p.points.length; k++) {
      const s = p.points[k];
      const e = p.points[k + 1];
      if (Math.abs(s.y - e.y) < 0.6 && Math.abs(s.x - e.x) > 2) segs.push({ kind: "H", a: (s.y + e.y) / 2, b0: Math.min(s.x, e.x), b1: Math.max(s.x, e.x) });
      else if (Math.abs(s.x - e.x) < 0.6 && Math.abs(s.y - e.y) > 2) segs.push({ kind: "V", a: (s.x + e.x) / 2, b0: Math.min(s.y, e.y), b1: Math.max(s.y, e.y) });
    }
  }
  return segs;
}

/** The size table on one page, or null where the page has none (or no text layer or rules to read). */
export async function readSpecPageTable(buffer: Buffer, page: number): Promise<SpecTable | null> {
  const items = await readTextItems(buffer, page);
  if (items.length === 0) return null;
  return readSpecTable(items, await readRuleSegments(buffer, page));
}
