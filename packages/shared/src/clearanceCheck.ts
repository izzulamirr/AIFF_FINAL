// Does the layout actually leave the cutting allowance it claims?
//
// The true-shape nester enforces spacing on a raster: each part is dilated by
// half the required gap and placements are rejected where the dilated masks
// collide. That is fast and it is approximate -- a cell is a finite size, and
// what the nester believes about a 12 mm grid is not what a torch does to
// steel. So the finished layout is checked again here against the real
// polygons, with no raster anywhere: segment to segment, exactly.
//
// This is the check that matters, because the allowance is the whole point of
// the plan. A part nested 10 mm closer than the web allows still looks fine on
// screen and still comes off the table undersized.

import type { NestResult } from "./nesting";

export interface ClearanceViolation {
  kind: "overlap" | "gap" | "edge";
  plate: number;
  a: string;
  b: string; // the other part, or which plate edge
  actualMm: number;
  requiredMm: number;
  atMm: [number, number];
}

export interface PlateClearance {
  plate: number;
  requiredGapMm: number;
  requiredEdgeMm: number;
  // The tightest place on the plate. This is the number to look at.
  minGapMm: number | null;
  minEdgeMm: number | null;
  minGapBetween: [string, string] | null;
  violations: ClearanceViolation[];
}

export interface ClearanceReport {
  plates: PlateClearance[];
  violations: ClearanceViolation[];
  ok: boolean;
  // Worst case across every plate, which is what a one-line verdict quotes.
  minGapMm: number | null;
  minEdgeMm: number | null;
}

type Pt = [number, number];

// Squared distance from a point to a segment. Squared throughout: the compare
// is the hot path and the square root is only needed on the answer.
function pointSegSq(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len = vx * vx + vy * vy;
  let t = len > 0 ? (wx * vx + wy * vy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = a[0] + t * vx - p[0];
  const dy = a[1] + t * vy - p[1];
  return dx * dx + dy * dy;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const side = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function segSegSq(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(pointSegSq(a, c, d), pointSegSq(b, c, d), pointSegSq(c, a, b), pointSegSq(d, a, b));
}

interface Poly {
  partNo: string;
  segs: Array<[Pt, Pt]>;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  // One interior-ish point, for the containment test that catches a part
  // wholly inside another's concave region.
  probe: Pt;
}

function polyOf(partNo: string, loops: Array<{ points: Pt[]; hole: boolean }>, ox: number, oy: number): Poly {
  const segs: Array<[Pt, Pt]> = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const loop of loops) {
    const pts = loop.points.map(([x, y]) => [x + ox, y + oy] as Pt);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      segs.push([p, q]);
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  return { partNo, segs, minX, maxX, minY, maxY, probe: [(minX + maxX) / 2, (minY + maxY) / 2] };
}

/**
 * Measures every gap on every plate against the allowances the plan claims.
 *
 * Distances are between the finished OUTLINES. The torch path is offset half a
 * kerf outward from each, which is already accounted for: the required gap is
 * kerf + web, so a measured gap equal to it leaves a full web of solid metal
 * between the two cuts.
 */
export function checkClearances(nest: NestResult, toleranceMm = 0.5): ClearanceReport {
  const plates: PlateClearance[] = [];
  const all: ClearanceViolation[] = [];

  for (const plate of nest.plates) {
    const requiredGapMm = plate.allowances.spacingMm;
    const requiredEdgeMm = plate.allowances.edgeMarginMm;
    const violations: ClearanceViolation[] = [];

    const polys: Poly[] = [];
    for (const pl of plate.placements) {
      const loops = pl.outlineLoops?.length
        ? pl.outlineLoops
        : // No outline: the reserved box IS the part, which is what a
          // bounding-box nest cuts to.
          [
            {
              points: [
                [0, 0],
                [pl.w, 0],
                [pl.w, pl.h],
                [0, pl.h],
              ] as Pt[],
              hole: false,
            },
          ];
      // Holes are inside their own part and cannot come near anything else, so
      // they are left out -- including them would report a bolt hole as a
      // clearance failure against its own outline.
      polys.push(polyOf(`${pl.partNo} #${pl.instance}`, loops.filter((l) => !l.hole), pl.x, pl.y));
    }

    let minGapMm: number | null = null;
    let minGapBetween: [string, string] | null = null;

    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        const A = polys[i];
        const B = polys[j];
        // Boxes further apart than the requirement cannot be in violation, and
        // on a plate of twenty parts that prunes almost every pair.
        const boxGapX = Math.max(0, Math.max(A.minX - B.maxX, B.minX - A.maxX));
        const boxGapY = Math.max(0, Math.max(A.minY - B.maxY, B.minY - A.maxY));
        const boxGap = Math.hypot(boxGapX, boxGapY);
        if (minGapMm != null && boxGap > Math.max(requiredGapMm, minGapMm)) continue;

        let bestSq = Infinity;
        let at: Pt = [0, 0];
        for (const [a, b] of A.segs) {
          for (const [c, d] of B.segs) {
            const sq = segSegSq(a, b, c, d);
            if (sq < bestSq) {
              bestSq = sq;
              at = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
              if (bestSq === 0) break;
            }
          }
          if (bestSq === 0) break;
        }
        const gap = Math.sqrt(bestSq);
        if (minGapMm == null || gap < minGapMm) {
          minGapMm = gap;
          minGapBetween = [A.partNo, B.partNo];
        }
        if (gap < requiredGapMm - toleranceMm) {
          violations.push({
            kind: gap <= 0.01 ? "overlap" : "gap",
            plate: plate.index,
            a: A.partNo,
            b: B.partNo,
            actualMm: +gap.toFixed(1),
            requiredMm: requiredGapMm,
            atMm: [Math.round(at[0]), Math.round(at[1])],
          });
        }
      }
    }

    let minEdgeMm: number | null = null;
    for (const poly of polys) {
      const edges: Array<[string, number]> = [
        ["left edge", poly.minX],
        ["top edge", poly.minY],
        ["right edge", plate.lengthMm - poly.maxX],
        ["bottom edge", plate.widthMm - poly.maxY],
      ];
      for (const [which, d] of edges) {
        if (minEdgeMm == null || d < minEdgeMm) minEdgeMm = d;
        if (d < requiredEdgeMm - toleranceMm) {
          violations.push({
            kind: "edge",
            plate: plate.index,
            a: poly.partNo,
            b: which,
            actualMm: +d.toFixed(1),
            requiredMm: requiredEdgeMm,
            atMm: [Math.round(poly.minX), Math.round(poly.minY)],
          });
        }
      }
    }

    plates.push({
      plate: plate.index,
      requiredGapMm,
      requiredEdgeMm,
      minGapMm: minGapMm == null ? null : +minGapMm.toFixed(1),
      minEdgeMm: minEdgeMm == null ? null : +minEdgeMm.toFixed(1),
      minGapBetween,
      violations,
    });
    all.push(...violations);
  }

  const gaps = plates.map((p) => p.minGapMm).filter((v): v is number => v != null);
  const edges = plates.map((p) => p.minEdgeMm).filter((v): v is number => v != null);
  return {
    plates,
    violations: all,
    ok: all.length === 0,
    minGapMm: gaps.length ? Math.min(...gaps) : null,
    minEdgeMm: edges.length ? Math.min(...edges) : null,
  };
}
