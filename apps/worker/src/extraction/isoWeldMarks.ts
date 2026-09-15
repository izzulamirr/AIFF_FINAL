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
  /** How far the leader tip was from the mark's centre -- a fit quality. */
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
const ARRIVED_PT = 6;
const MAX_HOPS = 5;
const MIN_LEADER_PT = 8;

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

  const nearestMark = (p: Pt) => {
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
    return { d: best, at };
  };

  const hits: WeldMarkHit[] = [];
  const untraced: Pt[] = [];

  for (const flag of flags) {
    type Walk = { at: Pt; hops: number; length: number; used: Set<GeomPath> };
    const starts: Walk[] = [];
    for (const seg of segments) {
      const a = seg.points[0];
      const b = seg.points[seg.points.length - 1];
      for (const [near, far] of [
        [a, b],
        [b, a],
      ] as Array<[Pt, Pt]>) {
        if (gapTo(flag.bbox, near) > 3) continue;
        if (!isOutside(flag.bbox, far, 3)) continue;
        if (dist(near, far) < MIN_LEADER_PT) continue;
        starts.push({ at: far, hops: 1, length: dist(near, far), used: new Set([seg]) });
      }
    }

    // Longest first: the leader is the line that actually goes somewhere, while
    // dimension and witness lines also touch a flag's box.
    const queue = starts.sort((x, y) => y.length - x.length).slice(0, 12);
    let best: { tip: Pt; hops: number; d: number; length: number } | null = null;
    while (queue.length > 0) {
      const node = queue.shift()!;
      const hit = nearestMark(node.at);
      if (hit.d <= ARRIVED_PT) {
        if (!best || node.length < best.length) best = { tip: hit.at ?? node.at, hops: node.hops, d: hit.d, length: node.length };
        continue; // arrived -- no reason to walk past it
      }
      if (node.hops >= MAX_HOPS) continue;
      for (const next of byEndpoint.get(cellKey(node.at)) ?? []) {
        if (node.used.has(next.seg)) continue;
        if (dist(next.from, node.at) > JOIN_TOLERANCE_PT * 1.5) continue;
        const used = new Set(node.used);
        used.add(next.seg);
        queue.push({ at: next.to, hops: node.hops + 1, length: node.length + dist(next.from, next.to), used });
      }
    }

    if (best) {
      hits.push({ flag: centre(flag), flagBox: flag.bbox, mark: best.tip, markDistance: best.d, hops: best.hops });
    } else {
      untraced.push(centre(flag));
    }
  }

  return { pageNumber, width: geom.width, height: geom.height, flagCount: flags.length, hits, untraced };
}
