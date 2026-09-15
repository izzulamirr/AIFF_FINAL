// Works out which spool each weld belongs to, by finding the spool boundaries
// on the drawing itself.
//
// The whole thing rests on one fact, checked against every sheet of the
// reference ISO and against the hand-verified answer: a spool is a CONTIGUOUS
// block of weld numbers. So a sheet's spool assignment is fully described by
// its cut points -- N printed spool tags means N-1 cuts -- and run order, which
// is the part geometry still cannot do reliably, is not needed at all.
//
// A cut is at one of exactly two things (see CLAUDE.md):
//   1. a FIELD WELD, which is read straight from the weld list, no drawing
//      needed, and
//   2. a VALVE flanged both sides on the main run, which is found here.
import { readPageGeometry, type GeomPath } from "../pdfGeometry";
import type { Pt, WeldMarkResult } from "./isoWeldMarks";

export interface WeldRow {
  weldNo: number;
  weldType?: string;
  size?: string;
}

export interface SpoolCutResult {
  cuts: number[];
  /** One line per cut found, saying what it was read from. */
  evidence: string[];
  /** Valves seen on the pipe but rejected, and why. */
  rejected: string[];
}

const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const boxW = (p: GeomPath) => p.bbox.x1 - p.bbox.x0;
const boxH = (p: GeomPath) => p.bbox.y1 - p.bbox.y0;

// A valve symbol is this big on these sheets; a glyph stroke is smaller.
const VALVE_MIN_PT = 10;
const VALVE_MAX_PT = 60;
// A valve sits ON the pipe. The title block and BOM table are full of glyph
// strokes that make the same shape -- hundreds of them on one sheet -- and the
// thing that separates them is that none is anywhere near a weld.
const ON_PIPE_PT = 60;
// How far from a valve to look for the welds either side of it.
const FLANK_PT = 90;

/** Does this 4-point path cross itself? An hourglass does; a flange bar does not. */
function selfCrossing(p: GeomPath): boolean {
  if (p.points.length !== 4) return false;
  const [a, b, c, d] = p.points;
  const side = (o: Pt, q: Pt, r: Pt) => Math.sign((q.x - o.x) * (r.y - o.y) - (q.y - o.y) * (r.x - o.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

/** The bore most of a sheet's welds are at IS the main run. */
function mainBore(welds: WeldRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const w of welds) {
    const s = String(w.size ?? "").trim();
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export async function readSpoolCuts(
  filePathOrBuffer: string | Buffer,
  pageNumber: number,
  marks: WeldMarkResult,
  welds: WeldRow[],
  /** Weld number for a located mark, from the flag contact sheet. */
  weldNumberOf: (hitIndex: number) => number | null
): Promise<SpoolCutResult> {
  const geom = await readPageGeometry(filePathOrBuffer, pageNumber);
  const positions = marks.hits.map((h) => h.mark);
  const bore = new Map(welds.map((w) => [w.weldNo, String(w.size ?? "").trim()]));
  const run = mainBore(welds);

  const cuts = new Set<number>();
  const evidence: string[] = [];
  const rejected: string[] = [];

  // (1) Field welds, straight off the weld list. A field weld IS the forced cut,
  // so this needs no drawing at all -- and on some sheets it is the whole answer.
  for (const w of welds) {
    if (String(w.weldType ?? "").trim().toUpperCase() !== "FW") continue;
    cuts.add(w.weldNo);
    evidence.push(`field weld ${w.weldNo} closes a spool, so the cut is after weld ${w.weldNo}`);
  }

  // (2) Valves. Collected as {centre, axis} whichever way CAD drew them: two
  // triangles meeting at a point, or one self-crossing four-point polyline.
  const candidates: Array<{ at: Pt; axis: Pt }> = [];
  for (const p of geom.paths) {
    if (p.paint !== "stroke" || p.extent < VALVE_MIN_PT || p.extent > VALVE_MAX_PT) continue;
    if (selfCrossing(p)) candidates.push({ at: centre(p), axis: { x: p.points[1].x - p.points[0].x, y: p.points[1].y - p.points[0].y } });
  }
  const tri = geom.paths.filter((p) => p.paint === "stroke" && p.points.length === 3 && p.extent >= VALVE_MIN_PT && p.extent < 40);
  const paired = new Set<number>();
  for (let i = 0; i < tri.length; i++) {
    if (paired.has(i)) continue;
    for (let j = i + 1; j < tri.length; j++) {
      if (paired.has(j)) continue;
      const a = tri[i];
      const b = tri[j];
      if (Math.abs(boxW(a) - boxW(b)) > 1 || Math.abs(boxH(a) - boxH(b)) > 1) continue;
      if (dist(centre(a), centre(b)) > a.extent * 0.9) continue;
      paired.add(i);
      paired.add(j);
      candidates.push({
        at: { x: (centre(a).x + centre(b).x) / 2, y: (centre(a).y + centre(b).y) / 2 },
        axis: { x: centre(b).x - centre(a).x, y: centre(b).y - centre(a).y },
      });
      break;
    }
  }

  for (const v of candidates) {
    if (positions.length === 0) continue;
    if (Math.min(...positions.map((m) => dist(m, v.at))) > ON_PIPE_PT) continue;

    // The valve's axis is the pipe. Take the nearest weld on EACH SIDE of it --
    // the two nearest overall can both sit on the same side, which is what put
    // one of sheet 2's cuts three welds early.
    const len = Math.hypot(v.axis.x, v.axis.y) || 1;
    const along = (m: Pt) => ((m.x - v.at.x) * v.axis.x + (m.y - v.at.y) * v.axis.y) / len;
    const near = positions
      .map((m, k) => ({ k, side: along(m), d: dist(m, v.at) }))
      .filter((m) => m.d < FLANK_PT);
    const fwd = near.filter((m) => m.side > 0).sort((a, b) => a.d - b.d)[0];
    const back = near.filter((m) => m.side < 0).sort((a, b) => a.d - b.d)[0];
    if (!fwd || !back) continue;

    const ns = [weldNumberOf(fwd.k), weldNumberOf(back.k)].filter((n): n is number => n != null);
    if (ns.length !== 2) {
      rejected.push(`a valve at (${v.at.x.toFixed(0)},${v.at.y.toFixed(0)}) has welds either side that have not been numbered, so its cut cannot be placed`);
      continue;
    }
    // The welds either side of a valve must be the same bore as each other --
    // otherwise the two picked are not a matching pair across one valve.
    //
    // Deliberately NOT a test against the sheet's main bore. A valve in a
    // REDUCED section of the main run is smaller than the line size and still
    // cuts a spool: sheet 2's 150mm gate valve sits between two 150mm welds on
    // a 200mm line, and filtering on the run bore threw away a real cut. What
    // catches a branch valve instead is the count check downstream -- N printed
    // spool tags means exactly N-1 cuts.
    const sizes = ns.map((n) => bore.get(n) ?? "");
    if (sizes[0] !== sizes[1]) {
      rejected.push(`the welds either side of the valve near (${v.at.x.toFixed(0)},${v.at.y.toFixed(0)}) are ${sizes.join(" and ")}mm, so they are not a pair across one valve`);
      continue;
    }
    // Spools are contiguous in weld number, so everything numbered below the
    // valve's downstream weld belongs to the spool ending here -- including any
    // branch welds numbered in between, which ride along with it.
    const cut = Math.max(...ns) - 1;
    if (cuts.has(cut)) continue;
    cuts.add(cut);
    evidence.push(`valve between welds ${[...ns].sort((a, b) => a - b).join(" and ")}, so the cut is after weld ${cut}`);
  }

  return { cuts: [...cuts].sort((a, b) => a - b), evidence, rejected };
}

/** Cuts -> which spool tag each weld sits in. */
export function assignSpools(welds: WeldRow[], cuts: number[], spoolTags: string[]): Map<number, string> {
  const sorted = [...welds].map((w) => w.weldNo).sort((a, b) => a - b);
  const edges = [...new Set(cuts)].sort((a, b) => a - b);
  const out = new Map<number, string>();
  for (const no of sorted) {
    const idx = edges.filter((c) => no > c).length;
    const tag = spoolTags[idx];
    if (tag) out.set(no, tag);
  }
  return out;
}
