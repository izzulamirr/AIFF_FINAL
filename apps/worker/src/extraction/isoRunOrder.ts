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
import { findFlowArrows, type FlowArrow } from "./isoFlowArrows";

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
  /** What decided which end the run starts from -- reported because it is the
   *  difference between the drawing saying so and the code assuming. */
  orientedBy: string;
  /** The flow arrows found on the sheet, if any. */
  flowArrows: FlowArrow[];
  /** Every run segment, pointed the way the pipe TRAVELS -- which is what says
   *  whether a leg is a rise or a drop. See where it is built for why this does
   *  not come from the weld walk. */
  orientedSegments: Array<{ from: Pt; to: Pt }>;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

// A fitting -- a valve with its flanges, a reducer, a gasket pair -- breaks the
// drawn run, so consecutive pipe polylines do not quite touch. This is how wide
// a break may be and still be the same run carrying on.
const FITTING_GAP_PT = 26;
// A weld mark this far or less from a run polyline is on it.
const ON_RUN_PT = 5;
// A flow arrow is drawn ON the pipe; isoFlowArrows only accepts one within 4pt
// of a heavy segment, so this only has to place it on the right EDGE.
const ON_ARROW_PT = 8;
// How near a weld must be to an open end to speak for its bore.
const END_BORE_PT = 60;

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

type RunEdge = { path: GeomPath; a: number; b: number; length: number };

/** Which run edge a point sits on, and where along it. */
function edgeUnder(at: Pt, edges: RunEdge[]): { edge: number; d: number } | null {
  let best: { edge: number; d: number } | undefined;
  edges.forEach((e, ei) => {
    for (let k = 1; k < e.path.points.length; k++) {
      const pr = project(at, e.path.points[k - 1], e.path.points[k]);
      if (!best || pr.d < best.d) best = { edge: ei, d: pr.d };
    }
  });
  return best && best.d <= ON_ARROW_PT ? best : null;
}

/** Does the arrow point the way this edge runs from its `a` end to its `b` end?
 *  Measured against the edge's own direction at the arrow, not end to end: a
 *  polyline bends, and the elbow past the arrow must not flip the sign. */
function dotAlongEdge(arrow: { at: Pt; dir: Pt }, e: RunEdge): number {
  let best: { d: number; dot: number } | undefined;
  for (let k = 1; k < e.path.points.length; k++) {
    const p0 = e.path.points[k - 1];
    const p1 = e.path.points[k];
    const L = dist(p0, p1);
    if (L < 1e-6) continue;
    const pr = project(arrow.at, p0, p1);
    const dot = arrow.dir.x * ((p1.x - p0.x) / L) + arrow.dir.y * ((p1.y - p0.y) / L);
    if (!best || pr.d < best.d) best = { d: pr.d, dot };
  }
  return best?.dot ?? 0;
}

/** The nodes reachable from `from` without using edge `without`. */
function componentWithout(from: number, without: number, edges: RunEdge[]): Set<number> {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const n = queue.pop() as number;
    edges.forEach((e, ei) => {
      if (ei === without) return;
      const other = e.a === n ? e.b : e.b === n ? e.a : null;
      if (other == null || seen.has(other)) return;
      seen.add(other);
      queue.push(other);
    });
  }
  return seen;
}

export async function readRunOrder(
  filePathOrBuffer: string | Buffer,
  pageNumber: number,
  marksIn?: WeldMarkResult,
  /** Weld number for a mark index, where they have been read. Orients the walk
   *  where the drawing prints no flow arrow. */
  numberOf?: (hitIndex: number) => number,
  /** The weld's BORE, from the weld list. Geometry cannot supply it, and it is
   *  what stops a 15mm vent stub being taken for a 200mm line's inlet. */
  boreOf?: (hitIndex: number) => string | undefined
): Promise<RunOrderResult> {
  const geom = await readPageGeometry(filePathOrBuffer, pageNumber);
  const flowArrows = findFlowArrows(geom.paths);
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
  const allEnds = (() => {
    const open = [...degree.entries()].filter(([, d]) => d === 1).map(([n]) => n);
    return open.length > 0 ? open : [...degree.keys()];
  })();

  // A BRANCH STUB IS NOT WHERE THE RUN STARTS, AND ITS BORE SAYS SO.
  //
  // The run graph is built from the heaviest line weight, which does not carry
  // the whole run, so a sheet can come back with the main run's inlet MISSING
  // and a vent stub's dead end the only open end left. Page 2 does exactly
  // that: its walk started at weld 6, a 15mm THREADED weld at the bottom of a
  // vent branch ending in a closed valve, which rooted the sheet at a dead end
  // and read that branch's 506mm drop as a RISE.
  //
  // Geometry cannot tell a 15mm leg from a 200mm one -- both are one line at
  // the pipe weight. The weld list can. The run's size is the MODE of the
  // sheet's own weld bores, so nothing is hard-coded and the sheet is compared
  // against itself.
  const mainBore = (() => {
    if (!boreOf) return undefined;
    const counts = new Map<string, number>();
    for (let i = 0; i < marks.length; i++) {
      const b = String(boreOf(i) ?? "").trim();
      if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    let best: string | undefined;
    let most = 0;
    for (const [b, n] of counts) if (n > most) [best, most] = [b, n];
    return best;
  })();
  const onMainRun = (node: number): boolean => {
    if (!boreOf || !mainBore) return true;
    let near: { bore: string; d: number } | undefined;
    for (let i = 0; i < marks.length; i++) {
      const d = dist(marks[i], nodes[node]);
      const bore = String(boreOf(i) ?? "").trim();
      if (!bore || d > END_BORE_PT) continue;
      if (!near || d < near.d) near = { bore, d };
    }
    // No weld near enough to judge: leave it in rather than rule out the real
    // inlet on no evidence.
    return !near || near.bore === mainBore;
  };
  const runEnds = allEnds.filter(onMainRun);
  const ends = runEnds.length > 0 ? runEnds : allEnds;

  let startNode = [...ends].sort((p, q) => nodes[p].y - nodes[q].y)[0];
  let orientedBy: RunOrderResult["orientedBy"] = "the topmost open end";
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
      orientedBy = `the end nearest weld ${lowest.n}, the lowest-numbered`;
    }
  }

  // A DRAWN FLOW ARROW BEATS BOTH, because it is the drawing saying so rather
  // than an assumption about how the draughtsman numbered.
  //
  // An arrow sits on one edge and points along it, which fixes the direction of
  // travel on THAT edge; the run's start is then whichever open end lies
  // upstream of it. Found by removing that edge from the graph and seeing which
  // side the upstream node falls on -- exact, and it copes with a run that
  // doubles back, which comparing straight-line directions would not.
  for (const arrow of flowArrows) {
    const on = edgeUnder(arrow.at, edges);
    if (!on) continue;
    // Which end of that edge the flow is heading for.
    const downstream = dotAlongEdge(arrow, edges[on.edge]) >= 0 ? edges[on.edge].b : edges[on.edge].a;
    const upstream = downstream === edges[on.edge].a ? edges[on.edge].b : edges[on.edge].a;
    const reachable = componentWithout(upstream, on.edge, edges);
    const upstreamEnds = ends.filter((n) => reachable.has(n));
    if (upstreamEnds.length === 0) continue;
    // SEVERAL OPEN ENDS UPSTREAM: take the one FURTHEST along the run.
    //
    // Upstream of the arrow lies the run's inlet and also the dead end of every
    // branch hanging off the stretch between. They are told apart by length --
    // the main run carries on across the sheet and off it, a vent or drain stub
    // is a few hundred millimetres. Page 2 is the case: its walk started at
    // weld 6, a 15mm THREADED weld at the bottom of a vent branch ending in a
    // closed valve, which rooted the whole sheet at a dead end and reported
    // that branch's 506mm drop as a RISE.
    const agrees = upstreamEnds.includes(startNode);
    startNode = agrees ? startNode : upstreamEnds.sort((p, q) => nodes[p].y - nodes[q].y)[0];
    // Whether the arrow CONFIRMED the weld numbering or overruled it. Worth
    // reporting either way: agreement is the evidence that swapping the
    // orientation rule was safe, and disagreement is the drawing telling you
    // the numbering does not follow the run on this sheet.
    orientedBy = agrees ? "a drawn flow arrow, agreeing with the weld numbering" : "a drawn flow arrow, OVERRULING the weld numbering";
    break;
  }

  // WHICH WAY THE PIPE TRAVELS AT EVERY POINT, from the same start.
  //
  // Not taken from the weld walk below: that one has to decide branch from main
  // run and which leg to take first, and it is only right on one sheet. This
  // needs none of that. Flow enters the run at one end and travels outward
  // through it, so orienting every edge AWAY FROM THE START is the whole
  // answer -- a breadth-first sweep of the graph, indifferent to weld adjacency,
  // branch classification and numbering alike.
  //
  // What it is for: naming a spool's extents. A DIMENSION has no direction of
  // its own -- it brackets an extent -- and deriving one from the order CAD
  // happened to write its two endpoints is meaningless, which is how one spool
  // came to report five vertical legs as UP, UP, DOWN, UP, UP. The pipe under
  // the dimension has a direction, and this is it.
  // Which way the pipe travels, from the sheet's start outward.
  //
  // Flow enters the run at one end and travels outward, so orienting every
  // edge AWAY FROM THE START is the whole answer -- a breadth-first sweep,
  // indifferent to weld adjacency, branch classification and numbering alike.
  // Only the start's own connected piece is oriented: the run graph comes from
  // the heaviest line weight and leaves a sheet in several disconnected
  // fragments, and a fragment holding no flow arrow has nothing to root it but
  // a guess at which end comes first. Guessing was measured and it is wrong
  // more often than right -- see the note on direction in spoolEnvelope.ts.
  const orientedSegments: Array<{ from: Pt; to: Pt }> = [];
  // ONLY WHERE A FLOW ARROW SAYS SO. Without one the start comes from the weld
  // numbering or, failing that, the topmost open end -- a guess, and measured
  // to be wrong more often than right: orienting arrow-less fragments that way
  // reversed every horizontal on two sheets. No arrow, no segments, and the
  // dimension keeps its drawn order.
  if (orientedBy.startsWith("a drawn flow arrow")) {
    const seen = new Set<number>([startNode]);
    const queue: number[] = [startNode];
    const usedHere = new Set<number>();
    while (queue.length > 0) {
      const n = queue.shift() as number;
      edges.forEach((e, ei) => {
        if (usedHere.has(ei) || (e.a !== n && e.b !== n)) return;
        usedHere.add(ei);
        const forward = e.a === n;
        const pts = forward ? e.path.points : [...e.path.points].reverse();
        for (let k = 1; k < pts.length; k++) orientedSegments.push({ from: pts[k - 1], to: pts[k] });
        const other = forward ? e.b : e.a;
        if (!seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      });
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
    orientedBy,
    flowArrows,
    orientedSegments,
  };
}
