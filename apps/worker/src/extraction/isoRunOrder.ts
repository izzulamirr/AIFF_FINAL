// Puts a sheet's welds in the order the pipe reaches them, from the drawing's
// own geometry.
//
// This is the other half of isoWeldMarks.ts. That one says WHERE each weld is;
// this one says what order they come in and which of them sit on branches --
// which is exactly what `comes_after_weld` is, and what the spool walk in
// packages/shared/src/spoolRules.ts consumes.
//
// Doing it geometrically matters because weld numbers do NOT follow the run: a
// sheet can go weld 2, then 4, then 3, and asking a model to trace the order by
// eye produced chains that skipped welds and reversed branches.
//
// The run is found by line weight -- it is drawn heavier than everything else on
// an isometric, which is the whole point of drawing it that way. Its polylines
// are then joined into a graph, with a tolerance that bridges the gaps left for
// fittings (a valve, a flange pair, a reducer breaks the drawn line), and walked
// in flow order: downward unless an arrow says otherwise, east leg before west
// at a branch.
import { readPageGeometry, type GeomPath } from "../pdfGeometry";
import { readWeldMarks, type Pt, type WeldMarkResult } from "./isoWeldMarks";

export interface RunWeld {
  /** Index into the WeldMarkResult.hits array this came from. */
  hitIndex: number;
  position: Pt;
  /** Index of the weld the run reaches immediately before this one; null for the first. */
  comesAfter: number | null;
  /** True when this weld sits on a branch rather than the main run. */
  onBranch: boolean;
  /** Distance along the run from its start, for ordering and for sanity checks. */
  along: number;
}

export interface RunOrderResult {
  pageNumber: number;
  /** Welds in the order the pipe reaches them. */
  welds: RunWeld[];
  /** Weld marks that did not sit on any run polyline. */
  offRun: Pt[];
  runPolylines: number;
  runLength: number;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

// A fitting -- a valve with its flanges, a reducer, a gasket pair -- breaks the
// drawn run, so consecutive pipe polylines do not quite touch. This is how wide
// a break may be and still be the same run carrying on.
const FITTING_GAP_PT = 26;
// A weld mark this far or less from a run polyline is on it.
const ON_RUN_PT = 5;

function project(p: Pt, a: Pt, b: Pt) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-9) return { d: dist(p, a), t: 0 };
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { d: dist(p, { x: a.x + t * vx, y: a.y + t * vy }), t };
}

function polylineLength(p: GeomPath): number {
  let l = 0;
  for (let i = 1; i < p.points.length; i++) l += dist(p.points[i - 1], p.points[i]);
  return l;
}

export async function readRunOrder(
  filePathOrBuffer: string | Buffer,
  pageNumber: number,
  marksIn?: WeldMarkResult,
  /** Weld number for a mark index, where they have been read. Orients the walk. */
  numberOf?: (hitIndex: number) => number
): Promise<RunOrderResult> {
  const geom = await readPageGeometry(filePathOrBuffer, pageNumber);
  const marksResult = marksIn ?? (await readWeldMarks(filePathOrBuffer, pageNumber));
  const marks = marksResult.hits.map((h) => h.mark);

  // The run is the heaviest thing drawn. Taking the max width off the page
  // itself means no hard-coded point size and no assumption about the exporter.
  const heaviest = geom.paths.reduce((m, p) => Math.max(m, p.lineWidth), 0);
  const pipes = geom.paths.filter((p) => p.lineWidth > heaviest - 0.2 && p.extent > 4 && p.points.length >= 2);

  // Each polyline is an edge; its two ends are nodes, merged when they meet
  // within the fitting gap.
  const nodes: Pt[] = [];
  const nodeOf = (p: Pt): number => {
    for (let i = 0; i < nodes.length; i++) if (dist(nodes[i], p) <= FITTING_GAP_PT) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  const edges = pipes.map((p) => ({
    path: p,
    a: nodeOf(p.points[0]),
    b: nodeOf(p.points[p.points.length - 1]),
    length: polylineLength(p),
  }));

  // Place every weld mark on the edge it sits on, and how far along it.
  const offRun: Pt[] = [];
  const weldsOnEdge = new Map<number, Array<{ hitIndex: number; t: number }>>();
  marks.forEach((m, hitIndex) => {
    let best: { edge: number; along: number; d: number } | undefined;
    edges.forEach((e, ei) => {
      let acc = 0;
      for (let k = 1; k < e.path.points.length; k++) {
        const a = e.path.points[k - 1];
        const b = e.path.points[k];
        const segLen = dist(a, b);
        const pr = project(m, a, b);
        if (!best || pr.d < best.d) best = { edge: ei, along: acc + pr.t * segLen, d: pr.d };
        acc += segLen;
      }
    });
    if (!best || best.d > ON_RUN_PT) {
      offRun.push(m);
      return;
    }
    const list = weldsOnEdge.get(best.edge) ?? [];
    list.push({ hitIndex, t: best.along });
    weldsOnEdge.set(best.edge, list);
  });
  for (const list of weldsOnEdge.values()) list.sort((x, y) => x.t - y.t);

  // Which end the run starts from. Page position cannot answer this: an
  // isometric is drawn on three 30-degree axes, so "up and to the right" on
  // paper is a HORIZONTAL direction in the plant, not a rise. Only the vertical
  // axis on the page is vertical in 3D, which makes "flow runs downward" a
  // statement about elevation that the page's y coordinate does not carry.
  //
  // The weld numbering does carry it. CAD numbers welds along the run in
  // fabrication order, which is the same order the sheet's PIPE SPOOLS schedule
  // is printed in -- so when the numbers are known, start from the end nearest
  // the lowest-numbered weld and the walk comes out in the sheet's own order.
  // Without them, fall back to the topmost open end.
  const degree = new Map<number, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  const ends = (() => {
    const open = [...degree.entries()].filter(([, d]) => d === 1).map(([n]) => n);
    return open.length > 0 ? open : [...degree.keys()];
  })();

  let startNode = [...ends].sort((p, q) => nodes[p].y - nodes[q].y)[0];
  if (numberOf) {
    let lowest: { hitIndex: number; n: number } | undefined;
    for (let i = 0; i < marks.length; i++) {
      const n = numberOf(i);
      if (!Number.isFinite(n)) continue;
      if (!lowest || n < lowest.n) lowest = { hitIndex: i, n };
    }
    if (lowest) {
      const target = marks[lowest.hitIndex];
      startNode = [...ends].sort((p, q) => dist(nodes[p], target) - dist(nodes[q], target))[0];
    }
  }

  // Walk the graph in flow order. At a fork the EAST leg is taken first, then
  // the west -- east being +x on the page, which is how these sheets are laid
  // out; a sheet whose north arrow says otherwise would need that read first.
  const welds: RunWeld[] = [];
  const usedEdge = new Set<number>();
  let previousWeld: number | null = null;
  let cumulative = 0;

  const walk = (node: number, arrivedAt: Pt, depth: number) => {
    const here = [...edges.entries()]
      .filter(([i, e]) => !usedEdge.has(i) && (e.a === node || e.b === node))
      .map(([i, e]) => {
        const startPoint = e.a === node ? e.path.points[0] : e.path.points[e.path.points.length - 1];
        return { i, e, gap: dist(startPoint, arrivedAt) };
      });
    // Continue from where the run actually got to. Node merging has to be loose
    // enough to bridge a fitting, which can pull several distinct points into
    // one node -- so picking the longest leg there jumps clean over the short
    // connector the run really takes next. Nearest first; length only breaks a
    // tie, and east before west after that.
    here.sort((p, q) => p.gap - q.gap || q.e.length - p.e.length || nodes[q.e.a].x - nodes[p.e.a].x);
    for (const { i: ei, e } of here) {
      if (usedEdge.has(ei)) continue;
      usedEdge.add(ei);
      const forward = e.a === node;
      const onIt = (weldsOnEdge.get(ei) ?? []).slice();
      if (!forward) onIt.reverse();
      for (const wd of onIt) {
        welds.push({
          hitIndex: wd.hitIndex,
          position: marks[wd.hitIndex],
          comesAfter: previousWeld,
          onBranch: depth > 0,
          along: cumulative + (forward ? wd.t : e.length - wd.t),
        });
        previousWeld = wd.hitIndex;
      }
      cumulative += e.length;
      const exitPoint = forward ? e.path.points[e.path.points.length - 1] : e.path.points[0];
      walk(forward ? e.b : e.a, exitPoint, depth + (here.length > 1 && ei !== here[0].i ? 1 : 0));
    }
  };
  walk(startNode, nodes[startNode], 0);

  // The run does not always come back as one connected component: a stretch can
  // be drawn at a different weight, or broken by a gap wider than the fitting
  // tolerance, leaving welds the first walk never reaches. Sweep whatever is
  // left so no weld is silently dropped -- taking the longest unused edge first,
  // since that is the most likely continuation of the main run. Ordering ACROSS
  // components is not established by this, only within each.
  let guard = edges.length;
  while (guard-- > 0) {
    const remaining = [...edges.entries()].filter(([i]) => !usedEdge.has(i) && (weldsOnEdge.get(i) ?? []).length > 0);
    if (remaining.length === 0) break;
    remaining.sort(([, e1], [, e2]) => e2.length - e1.length);
    const [, edge] = remaining[0];
    previousWeld = null; // a new component: nothing precedes its first weld
    walk(edge.a, nodes[edge.a], 0);
  }

  return {
    pageNumber,
    welds,
    offRun,
    runPolylines: pipes.length,
    runLength: edges.reduce((s, e) => s + e.length, 0),
  };
}
