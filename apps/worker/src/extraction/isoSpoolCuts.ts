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
//   2. a BOLTED JOINT on the main run, which is found here.
//
// The thing that ends a spool is the BOLTS, not the valve: a spool is what the
// shop welds up, so it stops wherever the line comes apart with a spanner. That
// is always drawn the same way -- a PAIR OF FLANGE BARS facing each other --
// whatever sits between them. On sheet 5 of the reference ISO the three
// boundaries are a ball valve, a swing check valve and a wafer check valve, and
// only the first has a recognisable valve symbol at all: the swing check is
// drawn as nothing but the gap between its two flanges. Looking for valve
// SYMBOLS found one of the three; looking for flange PAIRS finds all three.
//
// It also disposes of the branch valves for free. A branch dead-ends in a blind
// flange, which is bolted on rather than welded, so the far side of a branch
// valve has no weld -- and neither does a tie-in at the edge of the sheet,
// where the line continues onto another drawing. Requiring a weld on BOTH sides
// drops both without a special case.
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

// A FLANGE is a short bar drawn across the pipe: a small elongated polyline of
// four corners, usually with the first point repeated to close it. Every flange
// on a sheet is drawn to one size, so they are recognised by SHAPE and paired
// by likeness to each other -- nothing here is an absolute dimension off one
// drawing.
const FLANGE_MIN_PT = 6;
const FLANGE_MAX_PT = 60;
/** A flange bar is much longer than it is thick; a stray corner is not. */
const FLANGE_RATIO = 2.5;
/** Two flange faces bolted together, as a multiple of the flange's own width. */
const JOINT_SPAN = 3.5;
/** Two bars of one joint are drawn parallel. */
const PARALLEL_COS = 0.95;
/**
 * Two flanges bolt FACE TO FACE, so the line joining their centres runs ACROSS
 * the faces -- it is the pipe. Two bars sitting SIDE BY SIDE are offset ALONG
 * their faces instead, and are two different pipes' fittings that happen to be
 * near each other. On sheet 1 that distinction is the whole difference between
 * two cuts and three: its two 15mm vent branches each end in a socket-weld
 * fitting drawn as a bar, the two are parallel and close, and pairing them
 * invented a boundary between welds 18 and 21 that does not exist.
 */
const FACE_TO_FACE_COS = 0.7;
/** The welds either side of a joint lie in opposite directions from it. */
const OPPOSED_COS = -0.5;

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

export interface Bar {
  at: Pt;
  /** Direction of the bar's longest edge. */
  dir: Pt;
  long: number;
}

/** Longest and shortest edge of a path, which tells a thin bar from a blob far
 *  better than an axis-aligned bounding box does -- every line on an isometric
 *  is at 30 or 150 degrees, so a bar's box is never tight around it. */
function edgesOf(p: GeomPath): { long: number; short: number; dir: Pt } {
  let long = 0;
  let short = Infinity;
  let dir: Pt = { x: 1, y: 0 };
  const n = p.points.length;
  for (let i = 1; i < n; i++) {
    const a = p.points[i - 1];
    const b = p.points[i];
    const d = dist(a, b);
    if (d < 0.01) continue;
    if (d > long) {
      long = d;
      dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    }
    if (d < short) short = d;
  }
  return { long, short: Number.isFinite(short) ? short : 0, dir };
}

function findFlanges(paths: GeomPath[]): Bar[] {
  const out: Bar[] = [];
  for (const p of paths) {
    if (p.paint !== "stroke") continue;
    // Four corners, give or take the repeated closing point.
    if (p.points.length < 4 || p.points.length > 6) continue;
    const e = edgesOf(p);
    if (e.long < FLANGE_MIN_PT || e.long > FLANGE_MAX_PT) continue;
    if (e.short < 0.01 || e.long / e.short < FLANGE_RATIO) continue;
    out.push({ at: centre(p), dir: e.dir, long: e.long });
  }
  return out;
}

/** Flange bars paired off into bolted joints: alike in size, parallel, and
 *  close enough together to be bolted face to face. A lone bar is not a joint,
 *  which is what makes a tie-in at the sheet edge a non-event. */
export function boltedJoints(bars: Bar[]): Pt[] {
  const used = new Set<number>();
  const joints: Pt[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (used.has(i)) continue;
    let best: { j: number; d: number } | undefined;
    for (let j = i + 1; j < bars.length; j++) {
      if (used.has(j)) continue;
      const a = bars[i];
      const b = bars[j];
      if (Math.abs(a.long - b.long) > a.long * 0.15) continue;
      const d = dist(a.at, b.at);
      if (d < 1 || d > a.long * JOINT_SPAN) continue;
      if (Math.abs(a.dir.x * b.dir.x + a.dir.y * b.dir.y) < PARALLEL_COS) continue;
      const sep = { x: (b.at.x - a.at.x) / d, y: (b.at.y - a.at.y) / d };
      if (Math.abs(sep.x * a.dir.x + sep.y * a.dir.y) > FACE_TO_FACE_COS) continue;
      if (!best || d < best.d) best = { j, d };
    }
    if (!best) continue;
    used.add(i);
    used.add(best.j);
    joints.push({ x: (bars[i].at.x + bars[best.j].at.x) / 2, y: (bars[i].at.y + bars[best.j].at.y) / 2 });
  }
  return joints;
}

/** The two welds either side of a joint: the nearest one, then the nearest of
 *  those lying in the OPPOSITE direction from it.
 *
 *  Deliberately not projected onto an axis taken from the symbol. A valve drawn
 *  as two triangles can have both triangles sharing one centre, which made that
 *  axis (0,0) -- every weld then projected to side zero, no weld was on either
 *  side, and two real boundaries on sheet 5 were dropped by a bare `continue`.
 *  The welds themselves say which way the pipe runs; nothing else needs to. */
export function flankingWelds(at: Pt, positions: Pt[]): [number, number] | null {
  const near = positions
    .map((m, k) => ({ k, d: dist(m, at) }))
    .filter((x) => x.d < FLANK_PT && x.d > 0.01)
    .sort((a, b) => a.d - b.d);
  if (near.length < 2) return null;
  const first = near[0];
  const u = (m: Pt, d: number): Pt => ({ x: (m.x - at.x) / d, y: (m.y - at.y) / d });
  const d1 = u(positions[first.k], first.d);
  for (const c of near.slice(1)) {
    const d2 = u(positions[c.k], c.d);
    if (d1.x * d2.x + d1.y * d2.y <= OPPOSED_COS) return [first.k, c.k];
  }
  return null;
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

  // (2) Bolted joints: a pair of flange bars facing each other. This is the
  // general case -- it finds a boundary whatever sits between the flanges, a
  // valve with no drawn symbol included.
  const candidates: Pt[] = boltedJoints(findFlanges(geom.paths));

  // Valve symbols as well, for a joint whose flanges are drawn some other way.
  // A duplicate costs nothing: two candidates at one boundary yield the same
  // cut number and the set collapses them.
  for (const p of geom.paths) {
    if (p.paint !== "stroke" || p.extent < VALVE_MIN_PT || p.extent > VALVE_MAX_PT) continue;
    if (selfCrossing(p)) candidates.push(centre(p));
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
      candidates.push({ x: (centre(a).x + centre(b).x) / 2, y: (centre(a).y + centre(b).y) / 2 });
      break;
    }
  }

  const seen = new Set<string>();
  for (const at of candidates) {
    if (positions.length === 0) continue;
    // A joint sits ON the pipe. The title block and BOM table are full of
    // strokes that make these shapes -- and none is anywhere near a weld.
    if (Math.min(...positions.map((m) => dist(m, at))) > ON_PIPE_PT) continue;
    const key = `${at.x.toFixed(0)},${at.y.toFixed(0)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const pair = flankingWelds(at, positions);
    if (!pair) {
      // Not a failure to report loudly: a branch valve backed by a blind flange
      // and a tie-in at the sheet edge both land here, and both are correctly
      // not cuts. Recorded so a MISSING cut can still be traced to this step.
      rejected.push(`the joint at (${at.x.toFixed(0)},${at.y.toFixed(0)}) has a weld on only one side, so it ends nothing on this sheet`);
      continue;
    }
    const ns = [weldNumberOf(pair[0]), weldNumberOf(pair[1])].filter((n): n is number => n != null);
    if (ns.length !== 2) {
      rejected.push(`a joint at (${at.x.toFixed(0)},${at.y.toFixed(0)}) has welds either side that have not been numbered, so its cut cannot be placed`);
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
      rejected.push(`the welds either side of the joint near (${at.x.toFixed(0)},${at.y.toFixed(0)}) are ${sizes.join(" and ")}mm, so they are not a pair across one joint`);
      continue;
    }
    // Spools are contiguous in weld number, so everything numbered below the
    // valve's downstream weld belongs to the spool ending here -- including any
    // branch welds numbered in between, which ride along with it.
    const cut = Math.max(...ns) - 1;
    if (cuts.has(cut)) continue;
    cuts.add(cut);
    evidence.push(`bolted joint between welds ${[...ns].sort((a, b) => a - b).join(" and ")}, so the cut is after weld ${cut}`);
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
