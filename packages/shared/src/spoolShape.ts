// The SHAPE of a spool -- its legs in order, as a run through space.
//
// An envelope is three extents, and three extents describe a solid box. A
// spool is not a solid box. It is thin pipe tracing the edges of that box, and
// the difference is not academic:
//
//   N-02 runs DOWN 1412, then EAST 3437, then SOUTH 2381. Its bounding box is
//   1412 x 2381 x 3437, and the fit reads the cross-section as 1412 x 2381 --
//   a shape the spool does not have ANYWHERE along its length, because the
//   1412 leg is at one end and the 2381 leg at the other. As a box it will not
//   ship. As the run it actually is, it goes into a 20ft with 614mm to spare.
//
// WHY THE ORDER IS AVAILABLE, when this repo's notes say run topology is not
// solved. Those notes are about ORDERING WELDS -- deciding which weld the pipe
// reaches next, which needs a run graph built from line weights and has defeated
// four attempts. This is a different and much smaller question: every length
// that got placed in a spool carries the SEGMENT OF PIPE IT ATTACHES TO, found
// by sliding the dimension back onto the run, and those segments join end to
// end. Chaining them needs no graph, no bores and no weld numbers.
//
// It does not always work, and the failure is honest: a BRANCH joins the run in
// the middle of a leg rather than at its end, so the walk reaches a fork and
// stops. 12 of the reference ISO's 20 spools chain; the rest keep the bounding
// box, which is what they had before.
import type { PlantDirection } from "./isoAxes";

type Pt = { x: number; y: number };

/** A leg of the run: a length, its direction, and where it sits on the page. */
export interface LegInput {
  cell: string;
  mm: number;
  direction: PlantDirection;
  /** The pipe this length attaches to, in PAGE points. */
  from: Pt;
  to: Pt;
}

export interface SpoolShape {
  /** The legs in run order, start to finish. */
  legs: Array<{ cell: string; mm: number; direction: PlantDirection }>;
  /**
   * The run's corners in PLANT MILLIMETRES -- x east, y north, z up, starting
   * at the origin. This is the spool's real centreline, and the thing a
   * container check should be given instead of three extents.
   */
  points: Array<[number, number, number]>;
}

/**
 * Two attach ends this close are the same joint.
 *
 * Attach points are computed by sliding each dimension onto the run, so two
 * lengths meeting at an elbow land on the same point to within rounding --
 * the reference ISO's chains agree to well under a point. Loose enough to
 * survive that, tight enough that two different elbows never merge.
 */
const JOIN_PT = 6;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Which way each of the six directions goes, in plant millimetres. */
const STEP: Record<PlantDirection, [number, number, number]> = {
  E: [1, 0, 0],
  W: [-1, 0, 0],
  N: [0, 1, 0],
  S: [0, -1, 0],
  UP: [0, 0, 1],
  DOWN: [0, 0, -1],
};

/**
 * Walk a spool's legs into a single run, or say it cannot be done.
 *
 * Starts from a leg end that NOTHING ELSE touches -- the open end of the run --
 * and follows joints from there. Returns null unless every leg is used exactly
 * once: a partial walk is a branch or a gap, and half a shape is worse than
 * none, because the missing leg is exactly the one that might not fit.
 */
export function chainLegs(legs: LegInput[]): SpoolShape | null {
  if (legs.length === 0) return null;

  const touchedByOther = (at: Pt, self: number) =>
    legs.some((l, i) => i !== self && (dist(l.from, at) <= JOIN_PT || dist(l.to, at) <= JOIN_PT));

  let head: Pt | null = null;
  for (let i = 0; i < legs.length && !head; i++) {
    if (!touchedByOther(legs[i].from, i)) head = legs[i].from;
    else if (!touchedByOther(legs[i].to, i)) head = legs[i].to;
  }
  // Every end touches another: a closed loop, which a spool is not, or a
  // tangle the joint tolerance has merged. Either way, do not guess a start.
  if (!head) return null;

  const order: LegInput[] = [];
  const used = new Set<number>();
  let at: Pt = head;
  for (;;) {
    const candidates = legs
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => !used.has(i) && (dist(l.from, at) <= JOIN_PT || dist(l.to, at) <= JOIN_PT));
    if (candidates.length === 0) break;
    // A FORK IS A BRANCH, and a branch is not part of this run's line. Refuse
    // rather than pick one: taking either arm silently drops the other, and
    // the dropped arm is real pipe that has to go in the box too.
    if (candidates.length > 1) return null;
    const { l, i } = candidates[0];
    used.add(i);
    order.push(l);
    at = dist(l.from, at) <= JOIN_PT ? l.to : l.from;
  }
  if (order.length !== legs.length) return null;

  const points: Array<[number, number, number]> = [[0, 0, 0]];
  for (const leg of order) {
    const step = STEP[leg.direction];
    const [x, y, z] = points[points.length - 1];
    points.push([x + step[0] * leg.mm, y + step[1] * leg.mm, z + step[2] * leg.mm]);
  }
  return { legs: order.map((l) => ({ cell: l.cell, mm: l.mm, direction: l.direction })), points };
}

/**
 * The run's true extent along each plant axis.
 *
 * EXACT, where `axisExtent` in spoolEnvelope.ts is only a tight upper bound --
 * that one has to assume the worst order because it does not know the order.
 * This does. Where a run chains, this is the measurement and that is the bound.
 */
export function shapeExtent(shape: SpoolShape): { upDownMm: number; nsMm: number; ewMm: number } {
  const span = (i: number) => {
    const v = shape.points.map((p) => p[i]);
    return Math.round(Math.max(...v) - Math.min(...v));
  };
  return { ewMm: span(0), nsMm: span(1), upDownMm: span(2) };
}

/**
 * Extra pipe left at a field-adjusted joint, added to the run itself.
 *
 * A field weld CLOSES a spool, so its excess is pipe left on the end -- which
 * is modelled by carrying the last leg that much further, not by fattening a
 * box. Where the run has no legs there is nothing to extend.
 */
export function withFieldWeldAllowance(shape: SpoolShape, allowanceMm: number): SpoolShape {
  if (allowanceMm <= 0 || shape.legs.length === 0) return shape;
  const last = shape.legs[shape.legs.length - 1];
  const step = STEP[last.direction];
  const points = shape.points.slice();
  const [x, y, z] = points[points.length - 1];
  points[points.length - 1] = [x + step[0] * allowanceMm, y + step[1] * allowanceMm, z + step[2] * allowanceMm];
  return { legs: shape.legs, points };
}

/**
 * Outside diameter for a nominal bore, in millimetres (ASME B36.10).
 *
 * The bore is what the WELD LIST prints; the OD is what occupies a container.
 * They are not the same and the gap matters at small sizes -- a "15" bore pipe
 * is 21.3mm across, half as much again.
 *
 * Returns null for a bore not on the list rather than guessing. A guess here
 * is a number that makes a spool look like it fits, and the caller can fall
 * back to the bounding box, which never claims more than it should.
 */
const BORE_OD_MM: Record<number, number> = {
  15: 21.3, 20: 26.7, 25: 33.4, 32: 42.2, 40: 48.3, 50: 60.3, 65: 73.0, 80: 88.9,
  100: 114.3, 125: 141.3, 150: 168.3, 200: 219.1, 250: 273.0, 300: 323.9,
  350: 355.6, 400: 406.4, 450: 457.0, 500: 508.0, 600: 610.0,
};

export function nominalBoreOdMm(bore: string | number | undefined | null): number | null {
  if (bore == null) return null;
  const n = typeof bore === "number" ? bore : Number(String(bore).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return BORE_OD_MM[n] ?? null;
}
