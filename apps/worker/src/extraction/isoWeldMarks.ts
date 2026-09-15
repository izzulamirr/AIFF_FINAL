// Finds where each weld sits on an isometric sheet by reading the drawing's
// GEOMETRY instead of looking at a picture of it.
//
// The problem this solves: a weld is a small filled mark on the pipe with a thin
// leader line running out to a hexagonal flag carrying its number. Deciding
// which flag belongs to which mark is the step vision keeps getting wrong -- the
// leaders are long, cross each other and cross the pipe, so it is line-tracing
// rather than recognition. The same valve, cropped and asked three times, gave
// three different answers.
//
// Here it is a graph walk: start at a flag, follow the segments leaving it, and
// see which weld mark the leader arrives at. Deterministic, repeatable, free.
//
// What this CANNOT do is read the number inside a flag: these sheets are
// exported with the text outlined, so a label is a set of glyph paths and
// `getTextContent()` returns nothing. That is a separate, much easier problem --
// one small image per flag at a known location, against a candidate set the
// weld list already gives.
import { readPageGeometry, type GeomPath } from "../pdfGeometry";

export interface Pt {
  x: number;
  y: number;
}

export interface WeldMarkHit {
  /** Centre of the hexagonal number flag, in page points. */
  flag: Pt;
  /** Bounding box of the flag, for cropping it to read the number. */
  flagBox: { x0: number; y0: number; x1: number; y1: number };
  /** Where the leader lands: the weld's own mark on the pipe. */
  mark: Pt;
  /**
   * How far the leader's last point was from the mark's centre. Around 3pt means
   * the leader lands on the mark and the match is certain; a larger value means
   * the leader stopped short (at its arrowhead, or partway along a split
   * polyline) and the mark was matched by what the leader POINTS at, which is
   * good but less certain. Worth surfacing to a reviewer rather than hiding.
   */
  markDistance: number;
  /** Segments walked from flag to mark. */
  hops: number;
}

export interface WeldMarkResult {
  pageNumber: number;
  width: number;
  height: number;
  /** Every number flag found, whether or not its leader was traced. */
  flagCount: number;
  hits: WeldMarkHit[];
  /** Flags whose leader could not be followed to a mark. */
  untraced: Pt[];
}

const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const gapTo = (b: GeomPath["bbox"], p: Pt) => Math.max(0, b.x0 - p.x, p.x - b.x1) + Math.max(0, b.y0 - p.y, p.y - b.y1);
const isOutside = (b: GeomPath["bbox"], p: Pt, pad: number) => p.x < b.x0 - pad || p.x > b.x1 + pad || p.y < b.y0 - pad || p.y > b.y1 + pad;

// A weld number flag is a hexagon outline: six corners plus the closing point.
// Every one on a sheet is drawn to the same height, only the width changing with
// how many characters the label has ("BW7" vs "BW26").
const FLAG_POINTS = 7;
const FLAG_HEIGHT_PT = 15;
const FLAG_HEIGHT_TOLERANCE = 2;

// How close two segment ends have to be to count as the same vertex. CAD splits
// a bent leader into separate segments, so a leader is walked, not read off one
// path.
const JOIN_TOLERANCE_PT = 1.2;
// A leader that lands this close to a mark has plainly arrived at it.
const ARRIVED_PT = 6;
// Leaders end in an ARROWHEAD, and the arrowhead is drawn as its own filled
// triangle -- so the leader LINE stops at the arrow's base, short of the mark it
// points at. Rather than widen the radius blindly, which starts picking up
// whichever mark happens to be nearby, keep looking further but only STRAIGHT ON
// from the leader: the mark it means is the one it is pointing at.
const POINTING_PT = 40;
const POINTING_COS = 0.88; // ~28 degrees either side
const MAX_HOPS = 5;
const MIN_LEADER_PT = 5;

function findFlags(paths: GeomPath[]): GeomPath[] {
  return paths.filter(
    (p) =>
      p.points.length === FLAG_POINTS &&
      p.extent >= 10 &&
      p.extent <= 60 &&
      Math.abs(p.bbox.y1 - p.bbox.y0 - FLAG_HEIGHT_PT) < FLAG_HEIGHT_TOLERANCE
  );
}

// Deliberately NOT a roundness test. A weld mark is a circle drawn in one of the
// three isometric planes, so it projects to an ellipse squashed differently
// depending on which way its pipe runs -- a real mark came through 7.2 x 2.3pt.
// Size alone filters; which mark is meant is decided by where the leader lands.
function findMarks(paths: GeomPath[]): GeomPath[] {
  return paths.filter((p) => {
    if (p.paint !== "fillStroke") return false;
    const w = p.bbox.x1 - p.bbox.x0;
    const h = p.bbox.y1 - p.bbox.y0;
    return Math.min(w, h) >= 1.2 && Math.max(w, h) >= 2.5 && Math.max(w, h) <= 9;
  });
}

export async function readWeldMarks(filePathOrBuffer: string | Buffer, pageNumber: number): Promise<WeldMarkResult> {
  const geom = await readPageGeometry(filePathOrBuffer, pageNumber);
  const flags = findFlags(geom.paths);
  const marks = findMarks(geom.paths);
  const segments = geom.paths.filter(
    (p) => (p.paint === "stroke" || p.paint === "fillStroke") && !p.closed && p.points.length >= 2 && p.extent > 2
  );

  // Endpoint index, so "what continues from here" is a lookup rather than a scan
  // of every segment on the sheet.
  const cellKey = (p: Pt, dx = 0, dy = 0) => `${Math.round(p.x / JOIN_TOLERANCE_PT) + dx},${Math.round(p.y / JOIN_TOLERANCE_PT) + dy}`;
  const byEndpoint = new Map<string, Array<{ seg: GeomPath; from: Pt; to: Pt }>>();
  const index = (p: Pt, entry: { seg: GeomPath; from: Pt; to: Pt }) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k = cellKey(p, dx, dy);
        const list = byEndpoint.get(k);
        if (list) list.push(entry);
        else byEndpoint.set(k, [entry]);
      }
    }
  };
  for (const seg of segments) {
    const a = seg.points[0];
    const b = seg.points[seg.points.length - 1];
    index(a, { seg, from: a, to: b });
    index(b, { seg, from: b, to: a });
  }

  // Where a leader ends up: the mark it touches, or failing that the nearest one
  // it is pointing straight at. `heading` is the direction the leader was
  // travelling when it stopped.
  const arrivalFrom = (p: Pt, heading: Pt | null) => {
    let best = Infinity;
    let at: Pt | null = null;
    for (const m of marks) {
      const c = centre(m);
      const d = dist(c, p);
      if (d < best) {
        best = d;
        at = c;
      }
    }
    if (best <= ARRIVED_PT) return { d: best, at };

    if (heading) {
      const hlen = Math.hypot(heading.x, heading.y);
      if (hlen > 0.001) {
        const hx = heading.x / hlen;
        const hy = heading.y / hlen;
        let pointed = Infinity;
        let pointedAt: Pt | null = null;
        for (const m of marks) {
          const c = centre(m);
          const d = dist(c, p);
          if (d > POINTING_PT || d < 0.001) continue;
          const cos = ((c.x - p.x) / d) * hx + ((c.y - p.y) / d) * hy;
          if (cos < POINTING_COS) continue;
          if (d < pointed) {
            pointed = d;
            pointedAt = c;
          }
        }
        if (pointedAt) return { d: pointed, at: pointedAt };
      }
    }
    return { d: best, at };
  };

  const hits: WeldMarkHit[] = [];
  const untraced: Pt[] = [];

  for (const flag of flags) {
    type Walk = { at: Pt; from: Pt; hops: number; length: number; used: Set<GeomPath> };
    const starts: Walk[] = [];
    for (const seg of segments) {
      const a = seg.points[0];
      const b = seg.points[seg.points.length - 1];
      for (const [near, far] of [
        [a, b],
        [b, a],
      ] as Array<[Pt, Pt]>) {
        if (gapTo(flag.bbox, near) > 5) continue;
        if (!isOutside(flag.bbox, far, 3)) continue;
        if (dist(near, far) < MIN_LEADER_PT) continue;
        starts.push({ at: far, from: near, hops: 1, length: dist(near, far), used: new Set([seg]) });
      }
    }

    // Longest first: the leader is the line that actually goes somewhere, while
    // dimension and witness lines also touch a flag's box.
    const queue = starts.sort((x, y) => y.length - x.length).slice(0, 12);
    let best: { tip: Pt; hops: number; d: number; length: number } | null = null;
    while (queue.length > 0) {
      const node = queue.shift()!;
      const hit = arrivalFrom(node.at, { x: node.at.x - node.from.x, y: node.at.y - node.from.y });
      if (hit.at && hit.d <= POINTING_PT) {
        if (!best || node.length < best.length) best = { tip: hit.at ?? node.at, hops: node.hops, d: hit.d, length: node.length };
        continue; // arrived -- no reason to walk past it
      }
      if (node.hops >= MAX_HOPS) continue;
      for (const next of byEndpoint.get(cellKey(node.at)) ?? []) {
        if (node.used.has(next.seg)) continue;
        if (dist(next.from, node.at) > JOIN_TOLERANCE_PT * 1.5) continue;
        const used = new Set(node.used);
        used.add(next.seg);
        queue.push({ at: next.to, from: next.from, hops: node.hops + 1, length: node.length + dist(next.from, next.to), used });
      }
    }

    if (best) {
      hits.push({ flag: centre(flag), flagBox: flag.bbox, mark: best.tip, markDistance: best.d, hops: best.hops });
    } else {
      untraced.push(centre(flag));
    }
  }

  // Each weld mark belongs to exactly one flag, so two flags claiming the same
  // mark means at least one leader was followed to the wrong place. Keep the
  // better fit and give the other one back as untraced rather than reporting a
  // weld at a position that belongs to a different weld.
  const claimed = new Map<string, WeldMarkHit>();
  const kept: WeldMarkHit[] = [];
  for (const hit of [...hits].sort((a, b) => a.markDistance - b.markDistance)) {
    const k = `${hit.mark.x.toFixed(1)},${hit.mark.y.toFixed(1)}`;
    const held = claimed.get(k);
    if (held) {
      untraced.push(hit.flag);
      continue;
    }
    claimed.set(k, hit);
    kept.push(hit);
  }

  return { pageNumber, width: geom.width, height: geom.height, flagCount: flags.length, hits: kept, untraced };
}
