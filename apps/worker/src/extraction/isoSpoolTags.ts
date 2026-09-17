// The PIPE SPOOLS tags printed on a sheet, and WHICH PIECE OF PIPE each one
// points at.
//
// This exists because mapping tags onto weld blocks in sorted order is wrong,
// and the drawing says so plainly. On sheet 4 of the reference ISO the tag
// `...-N-14` has its leader on the 6000mm piece between the two FW ticks --
// the MIDDLE block -- while sorted order gives that block to N-13. The tag
// numbers are simply not in run order on that sheet.
//
// A spool tag is drawn the same way everywhere on these sheets: a boxed tag
// string with a leader running to the run. Finding the box and following the
// leader is the drawing telling you the answer, so take it.
import type { GeomPath } from "../pdfGeometry";
import type { Pt } from "./isoWeldMarks";

/** A tag string is long, so its box is wide and short. */
const BOX_MIN_W = 120;
const BOX_MAX_W = 420;
const BOX_MIN_H = 7;
const BOX_MAX_H = 26;
/** Annotation weight; the run is heavier. */
const MAX_LEADER_LW = 1.5;
const MIN_LEADER_PT = 4;
/** How close a leader must start to its box. */
const LEAVES_BOX_PT = 3;
/** ...and how far from it the other end must be, so a box edge is not a leader. */
const LEADER_REACH_PT = 15;
/** Walking a bent leader: CAD splits one into separate segments. */
const HOP_PT = 10;
const MAX_HOPS = 12;
/** The run is the heavy line. */
const PIPE_MIN_LW = 1.5;
/**
 * How far a leader's tip may sit from the run.
 *
 * A leader POINTS at the pipe, it does not have to touch it, and on sheet 4
 * two of the three are broken where the 15109mm overall dimension crosses
 * them -- leaving the tip some 65pt short. The tip is put on the pipe before
 * anything is asked of it.
 */
const MAX_OFF_RUN_PT = 110;
/**
 * How far along the run to look for the welds either side of the landing
 * point.
 *
 * Much longer than the equivalent in the cut finder (90pt), and for a reason:
 * that one looks for the welds flanking a VALVE, which are close together,
 * while this looks for the welds at either END OF A SPOOL. Sheet 4's 6000mm
 * piece has its two welds 144pt apart, so a 90pt reach finds only one of them
 * and reports no pair at all.
 */
const FLANK_PT = 240;
/** Two welds count as either side when they point away from each other. */
const OPPOSED_COS = -0.5;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const gapToBox = (b: GeomPath["bbox"], p: Pt) =>
  Math.max(0, b.x0 - p.x, p.x - b.x1) + Math.max(0, b.y0 - p.y, p.y - b.y1);

export interface SpoolTagLeader {
  /** Box around the printed tag string, for cropping it to be read. */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Where the leader stops. */
  tip: Pt;
  /** That tip put onto the run, which is the piece being pointed at. */
  at: Pt;
  /** How far the tip was from the run. Large means a broken leader. */
  offRunPt: number;
  /** The welds either side of the landing point, ascending. Null if unclear. */
  flanking: [number, number] | null;
}

/** Boxes that could hold a tag string. */
function tagBoxes(paths: GeomPath[]): GeomPath[] {
  return paths.filter((p) => {
    if (p.paint !== "stroke") return false;
    if (p.points.length < 4 || p.points.length > 6) return false;
    const w = p.bbox.x1 - p.bbox.x0;
    const h = p.bbox.y1 - p.bbox.y0;
    return w >= BOX_MIN_W && w <= BOX_MAX_W && h >= BOX_MIN_H && h <= BOX_MAX_H;
  });
}

/**
 * The welds either side of a point on the run: the nearest, then the nearest
 * of those lying in the OPPOSITE direction from it.
 *
 * Same shape as the cut finder's test and for the same reason -- the welds
 * themselves say which way the pipe runs, so no axis has to be taken from a
 * symbol -- but with a far longer reach, because a spool is long.
 */
function flankingAlongRun(at: Pt, welds: Array<{ weldNo: number; mark: Pt }>): [number, number] | null {
  const near = welds
    .map((w) => ({ w, d: dist(w.mark, at) }))
    .filter((x) => x.d < FLANK_PT && x.d > 0.01)
    .sort((a, b) => a.d - b.d);
  if (near.length < 2) return null;
  const unit = (m: Pt, d: number): Pt => ({ x: (m.x - at.x) / d, y: (m.y - at.y) / d });
  const first = near[0];
  const d1 = unit(first.w.mark, first.d);
  for (const c of near.slice(1)) {
    const d2 = unit(c.w.mark, c.d);
    if (d1.x * d2.x + d1.y * d2.y <= OPPOSED_COS) {
      return [Math.min(first.w.weldNo, c.w.weldNo), Math.max(first.w.weldNo, c.w.weldNo)];
    }
  }
  return null;
}

export function findSpoolTagLeaders(paths: GeomPath[], welds: Array<{ weldNo: number; mark: Pt }>): SpoolTagLeader[] {
  const boxes = tagBoxes(paths);
  const thin: Array<{ a: Pt; b: Pt; len: number }> = [];
  const pipes: Array<{ a: Pt; b: Pt }> = [];
  for (const p of paths) {
    if (p.paint === "fill") continue;
    for (let i = 1; i < p.points.length; i++) {
      const a = p.points[i - 1];
      const b = p.points[i];
      const len = dist(a, b);
      if (len <= 1) continue;
      if (p.paint === "stroke" && p.lineWidth <= MAX_LEADER_LW && len > MIN_LEADER_PT) thin.push({ a, b, len });
      if (p.lineWidth >= PIPE_MIN_LW) pipes.push({ a, b });
    }
  }

  const out: SpoolTagLeader[] = [];
  for (const box of boxes) {
    // The longest segment leaving this box is its leader.
    let tip: Pt | null = null;
    let best = 0;
    for (const s of thin) {
      const da = gapToBox(box.bbox, s.a);
      const db = gapToBox(box.bbox, s.b);
      if (Math.min(da, db) > LEAVES_BOX_PT) continue;
      const end = da < db ? s.b : s.a;
      if (gapToBox(box.bbox, end) < LEADER_REACH_PT) continue;
      if (s.len > best) {
        best = s.len;
        tip = end;
      }
    }
    if (!tip) continue;
    // Follow it through its bends and breaks.
    const walked = new Set<object>();
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      let next: Pt | null = null;
      for (const s of thin) {
        if (walked.has(s)) continue;
        const da = dist(s.a, tip);
        const db = dist(s.b, tip);
        if (Math.min(da, db) > HOP_PT) continue;
        const other = da < db ? s.b : s.a;
        if (dist(other, tip) <= HOP_PT) continue;
        if (gapToBox(box.bbox, other) < LEADER_REACH_PT) continue;
        walked.add(s);
        next = other;
        break;
      }
      if (!next) break;
      tip = next;
    }
    // Put it on the run before asking which welds are either side: off the
    // pipe, the two welds bracketing a piece both lie in the same direction
    // and no pair is found at all.
    let offRunPt = Infinity;
    let at: Pt = tip;
    for (const s of pipes) {
      const L = dist(s.a, s.b) || 1;
      const t = Math.max(0, Math.min(1, ((tip.x - s.a.x) * (s.b.x - s.a.x) + (tip.y - s.a.y) * (s.b.y - s.a.y)) / (L * L)));
      const foot = { x: s.a.x + t * (s.b.x - s.a.x), y: s.a.y + t * (s.b.y - s.a.y) };
      const d = dist(tip, foot);
      if (d < offRunPt) {
        offRunPt = d;
        at = foot;
      }
    }
    if (offRunPt > MAX_OFF_RUN_PT) continue;
    out.push({
      box: box.bbox,
      tip,
      at,
      offRunPt: Number(offRunPt.toFixed(1)),
      flanking: flankingAlongRun(at, welds),
    });
  }
  return out.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
}

/**
 * Which weld block does a tag point at?
 *
 * Blocks are contiguous runs of weld numbers separated by the cuts. A tag
 * landing between two welds in DIFFERENT blocks is pointing at the piece
 * after the cut, so the later block takes it -- a field weld closes the spool
 * it ends. That is sheet 4's 6000mm piece, whose leader lands between welds 6
 * and 7 with the cut at 6.
 */
export function blockOfLeader(flanking: [number, number] | null, cuts: number[]): number | null {
  if (!flanking) return null;
  const edges = [...new Set(cuts)].sort((a, b) => a - b);
  const blockOf = (weldNo: number) => edges.filter((c) => weldNo > c).length;
  return blockOf(Math.max(flanking[0], flanking[1]));
}

/**
 * Order a sheet's printed tags by the BLOCK each one's leader points at,
 * instead of by sorted tag number.
 *
 * Sorted order is kept wherever the drawing does not contradict it, and the
 * result is only accepted if it is a PERMUTATION of the tags the sheet
 * prints: every tag used once, none invented, none dropped. A partial or
 * duplicated reading means a leader was followed somewhere wrong, and the
 * sorted order -- which at least uses each tag once -- is the safer answer.
 *
 * Measured across the reference ISO: 13 of the 15 tags whose leaders resolve
 * agree with sorted order, and the two that do not are sheet 4's N-13 and
 * N-14. Reproducing the existing answer everywhere it is right is what makes
 * the one disagreement worth acting on.
 */
export function tagsByBlock(
  leaders: Array<{ tag: string | null; block: number | null }>,
  fallback: string[]
): { tags: string[]; changed: Array<{ block: number; from: string; to: string }>; why?: string } {
  const placed = new Map<number, string>();
  for (const l of leaders) {
    if (!l.tag || l.block == null) continue;
    if (l.block < 0 || l.block >= fallback.length) return { tags: fallback, changed: [], why: "a leader points outside the sheet's blocks" };
    if (placed.has(l.block)) return { tags: fallback, changed: [], why: `two tags point at block ${l.block}` };
    placed.set(l.block, l.tag);
  }
  if (placed.size === 0) return { tags: fallback, changed: [], why: "no tag leader resolved" };
  const next = fallback.map((t, i) => placed.get(i) ?? t);
  const sortedOf = (xs: string[]) => [...xs].sort().join("|");
  if (sortedOf(next) !== sortedOf(fallback)) {
    return { tags: fallback, changed: [], why: "the leaders do not use each printed tag exactly once" };
  }
  const changed = next
    .map((t, i) => ({ block: i, from: fallback[i], to: t }))
    .filter((c) => c.from !== c.to);
  return { tags: next, changed };
}
