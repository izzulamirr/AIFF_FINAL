// The FLOW ARROWS drawn on an isometric, read off the drawing's own geometry.
//
// Which way a run goes is the input the geometric weld ordering never had. Page
// position cannot supply it -- an isometric is drawn on three 30-degree axes, so
// "up and to the right" on paper is a HORIZONTAL direction in the plant, and
// "flow runs downward" is a statement about elevation the page's y does not
// carry. So `isoRunOrder` oriented its walk from the weld NUMBERING instead,
// on the reasoning that CAD numbers welds along the run. That is an assumption
// about the draughtsman, not a reading of the drawing.
//
// A flow arrow says it outright, and the revised reference ISO draws them.
//
// WHY A BARE "FILLED TRIANGLE" SEARCH IS USELESS. A page holds 2,500-5,200
// filled triangles. Almost all are glyph strokes in the title block and the
// tables; of the rest, a leader ends in a filled triangle and so does every
// dimension terminator. An earlier attempt at this reported 58-60 mid-pipe hits
// a page and was abandoned as too noisy.
//
// THREE THINGS TOGETHER PICK THEM OUT, and the separation is total. Measured
// across both revisions of the reference ISO -- the earlier one draws no flow
// arrows at all, which makes it a true negative control:
//
//   page                      1      2      3      4      5
//   filled triangles       2957   5195   3428   4745   2577
//   ON a pipe (<=4pt)       783    806    386    652    485
//   ...and ALONG it (<=10d) 342    239    137    205    137
//   ...and with an OUTLINE    1      1      1      1      0     <- the arrows
//   same page, OLD drawing    0      0      0      0      0     <- the control
//
// Not one false positive on five sheets that have none, and exactly one arrow
// found on each sheet that has one. Every hit sits 0.2-1.3pt off the pipe and
// 1.0-1.9 degrees off its axis, so nothing is near the thresholds.
//
// The OUTLINE is the discriminator worth understanding: a flow arrow is drawn
// as a filled triangle PLUS a stroked four-point outline round it that crosses
// itself, while a leader or dimension arrowhead is the filled triangle alone.
// That same self-crossing outline is what fooled the spool cut finder into
// reading an arrow as a valve -- see isoSpoolCuts.ts. The shape that broke that
// is the shape that identifies this.
//
// Deliberately NOT filtered by size, though every arrow here measures 13.7-15.0
// points. The conjunction already separates the two drawings completely, so a
// size bound would add nothing but a number fitted to one CAD library.
import { readPageGeometry, type GeomPath } from "../pdfGeometry";
import type { Pt } from "./isoWeldMarks";

export interface FlowArrow {
  /** Centre of the arrowhead, which is where it sits on the run. */
  at: Pt;
  /** The tip. */
  apex: Pt;
  /** Unit vector the flow travels in, in page coordinates (y runs DOWN). */
  dir: Pt;
  /** How far off the pipe it sits, in points -- small means certain. */
  onPipePt: number;
  /** How far off the pipe's own axis it points, in degrees. */
  alongDeg: number;
}

/** A filled arrowhead is on the pipe, not merely near it. */
const ON_PIPE_PT = 4;
/** And it points ALONG the pipe, which a leader's arrowhead does not. */
const ALONG_DEG = 10;
/**
 * How far the stroked outline's centre may sit from the filled head's.
 *
 * They do NOT quite coincide. The outline is a four-point path whose corners
 * are not the triangle's, so its bbox centre drifts -- 3.1pt on sheet 5, which
 * a 3pt test missed by a tenth of a point and cost that sheet its only arrow.
 * Measured through the module itself on both revisions: 3 finds 4 of the 5, and
 * 4, 5, 6 and 8 all find 5 of 5 with none on the drawing that has none. A
 * plateau that wide is a threshold worth sitting in the middle of.
 */
const OUTLINE_PT = 5;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });

/**
 * Which way a triangle POINTS.
 *
 * The apex is the vertex furthest from the midpoint of the opposite edge -- an
 * arrowhead is long and narrow, so that vertex is the tip and the other two are
 * its base. Taking the direction from the BASE MIDPOINT rather than from the
 * centroid matters: the centroid sits a third of the way up, which skews the
 * direction on a stubby head.
 */
export function apexOf(t: GeomPath): { apex: Pt; dir: Pt } | null {
  const p = t.points.slice(0, 3);
  if (p.length !== 3) return null;
  let best: { apex: Pt; dir: Pt; d: number } | undefined;
  for (let i = 0; i < 3; i++) {
    const apex = p[i];
    const a = p[(i + 1) % 3];
    const b = p[(i + 2) % 3];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = dist(apex, mid);
    if (d < 1e-6) continue;
    if (!best || d > best.d) best = { apex, dir: { x: (apex.x - mid.x) / d, y: (apex.y - mid.y) / d }, d };
  }
  return best ? { apex: best.apex, dir: best.dir } : null;
}

/** A four-point path that crosses itself -- the outline drawn round a flow
 *  arrow's head, and the thing that tells it from every other arrowhead. */
function selfCrossing(p: GeomPath): boolean {
  if (p.points.length !== 4) return false;
  const [a, b, c, d] = p.points;
  const side = (o: Pt, q: Pt, r: Pt) => Math.sign((q.x - o.x) * (r.y - o.y) - (q.y - o.y) * (r.x - o.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

export function findFlowArrows(paths: GeomPath[]): FlowArrow[] {
  if (paths.length === 0) return [];
  // The pipe is the heaviest thing drawn -- the same test isoRunOrder uses, and
  // read off the page rather than hard-coded so no exporter is assumed.
  const heaviest = paths.reduce((m, p) => Math.max(m, p.lineWidth), 0);
  const segments: Array<[Pt, Pt]> = [];
  for (const p of paths) {
    if (p.lineWidth < heaviest - 0.2 || p.points.length < 2) continue;
    for (let i = 1; i < p.points.length; i++) segments.push([p.points[i - 1], p.points[i]]);
  }
  if (segments.length === 0) return [];

  const outlines = paths.filter((p) => p.paint === "stroke" && selfCrossing(p)).map(centre);
  if (outlines.length === 0) return [];

  const out: FlowArrow[] = [];
  for (const t of paths) {
    if (t.paint !== "fill" && t.paint !== "fillStroke") continue;
    if (t.points.length !== 3) continue;
    const a = apexOf(t);
    if (!a) continue;
    const c = centre(t);
    if (!outlines.some((o) => dist(o, c) < OUTLINE_PT)) continue;

    let near: { d: number; along: number } | undefined;
    for (const [s0, s1] of segments) {
      const L = dist(s0, s1);
      if (L < 1) continue;
      const vx = (s1.x - s0.x) / L;
      const vy = (s1.y - s0.y) / L;
      const tt = Math.max(0, Math.min(1, ((c.x - s0.x) * vx + (c.y - s0.y) * vy) / L));
      const d = dist(c, { x: s0.x + tt * L * vx, y: s0.y + tt * L * vy });
      if (near && d >= near.d) continue;
      // Parallel either way round: the arrow's own direction says which way the
      // flow goes, the pipe only has to be the thing it is drawn on.
      const cos = Math.min(1, Math.abs(a.dir.x * vx + a.dir.y * vy));
      near = { d, along: (Math.acos(cos) * 180) / Math.PI };
    }
    if (!near || near.d > ON_PIPE_PT || near.along > ALONG_DEG) continue;
    out.push({ at: c, apex: a.apex, dir: a.dir, onPipePt: near.d, alongDeg: near.along });
  }
  return out;
}

export async function readFlowArrows(filePathOrBuffer: string | Buffer, pageNumber: number): Promise<FlowArrow[]> {
  const { paths } = await readPageGeometry(filePathOrBuffer, pageNumber);
  return findFlowArrows(paths);
}
