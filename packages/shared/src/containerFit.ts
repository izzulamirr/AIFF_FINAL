// Will a spool fit in a shipping container?
//
// Deterministic arithmetic over an envelope, so it costs nothing to run and
// can be re-run on every extraction. The hard part is upstream -- getting a
// spool's real L x W x H off a drawing that is not to scale -- and this module
// deliberately takes the envelope as an input rather than trying to derive it,
// so a hand-measured spool and an extracted one are checked the same way.
//
// Three things here that a naive "is it shorter than the container" check gets
// wrong, and each of them has bitten a real shipment:
//
//   1. A spool can be TURNED, and it can be ANGLED. Only the set of three
//      sizes matters, not which one was called length -- and a spool longer
//      than the container still goes in if it is swung diagonally across the
//      floor. A 20ft is 5,898mm end to end but 6,350mm corner to corner.
//   2. It has to get THROUGH THE DOOR. A door opening is smaller than the
//      section behind it -- 2,340 x 2,280 against 2,352 x 2,393 on a 20ft --
//      so a spool can fit the space and still not go in end-first.
//   3. A FIELD WELD needs slack. The reference ISO's NOTE 4 reads "WHENEVER
//      FIELD ADJUSTED JOINT (FAJ) IS INDICATED, AN EXCESS OF 150mm TO BE
//      PROVIDED" -- that excess is extra pipe left on the spool to be cut to
//      suit on site, so it is part of what gets shipped.

/** A spool's overall size, in millimetres. Order carries no meaning. */
export interface Envelope {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

export interface ContainerSpec {
  name: string;
  /** Usable internal space. */
  internal: Envelope;
  /**
   * Clear door opening, width x height. Absent for a container loaded from
   * above (open-top, flat rack), where nothing has to pass an opening.
   */
  door?: { widthMm: number; heightMm: number };
  /**
   * Special equipment -- open top, flat rack. It will take things an ordinary
   * box will not, but it costs more, is harder to get and needs the load
   * weatherproofed and lashed. So it is never the answer while a dry box
   * works, even where its internal volume happens to be smaller.
   */
  special?: boolean;
}

export interface FitResult {
  container: string;
  fits: boolean;
  /**
   * "straight" -- square to the container, the easy load.
   * "angled"   -- swung across the floor but still flat, which is how
   *               anything longer than the container usually goes in.
   * "tilted"   -- turned in all three axes, reaching the container's full
   *               body diagonal (6,786mm in a 20ft against 6,350mm across
   *               the floor). It fits, but it has to be cradled at an angle
   *               in both planes, so it is the last resort of the three.
   *
   * All three fit. The distinction is how much rigging it takes, which is a
   * DECISION -- angling costs usable floor and needs blocking against the
   * pipe working back square -- so it is surfaced rather than assumed.
   */
  how: "straight" | "angled" | "tilted" | null;
  /** Yaw off square, in degrees. 0 when it loads straight. */
  angleDeg: number | null;
  /** The full attitude, when it only fits turned in all three axes. */
  tilt?: { yawDeg: number; pitchDeg: number; rollDeg: number };
  /** How the spool has to be turned to fit, as [length, width, height]. */
  orientation: [number, number, number] | null;
  /** Smallest gap on any axis, in mm -- how close it is to not fitting. */
  tightestMm: number | null;
  /** Why it does not fit, when it does not. */
  blockedBy: string[];
  /**
   * HOW FAR IT MISSED, in mm, over the best attitude found -- set only when
   * it does not fit.
   *
   * Without this a 6mm miss and a 3-metre miss both read "will not ship",
   * which are not the same answer at all. N-10 carrying its field weld is
   * 6150 x 721 x 457 and misses a 20ft by **5.6mm** at yaw 15 / pitch 15 /
   * roll 45.75 -- 0.09% of its length, and far inside the few tens of mm real
   * containers vary by. Calling that "no" on a nominal spec is a stronger
   * claim than the specs support.
   */
  shortfallMm?: number;
}

/**
 * Nominal internal sizes for the common ISO dry containers, in millimetres.
 *
 * These VARY between operators and build years by a few tens of millimetres,
 * which is the same order as a tight clearance -- so where a spool comes out
 * within ~50mm of fitting, the answer is "confirm against the actual
 * container", not "yes". Pass your own specs to override.
 */
export const STANDARD_CONTAINERS: ContainerSpec[] = [
  {
    name: "20ft GP",
    internal: { lengthMm: 5898, widthMm: 2352, heightMm: 2393 },
    door: { widthMm: 2340, heightMm: 2280 },
  },
  {
    name: "40ft GP",
    internal: { lengthMm: 12032, widthMm: 2352, heightMm: 2393 },
    door: { widthMm: 2340, heightMm: 2280 },
  },
  {
    name: "40ft HC",
    internal: { lengthMm: 12032, widthMm: 2352, heightMm: 2698 },
    door: { widthMm: 2340, heightMm: 2585 },
  },
  // Loaded from above, so there is no opening to pass through -- the usual
  // answer for a spool that beats the space but not the door.
  { name: "20ft open top", internal: { lengthMm: 5898, widthMm: 2352, heightMm: 2347 }, special: true },
  { name: "40ft flat rack", internal: { lengthMm: 12080, widthMm: 2438, heightMm: 2103 }, special: true },
];

/**
 * TWENTY FOOT ONLY -- what this refinery actually ships in.
 *
 * `STANDARD_CONTAINERS` stays the full reference list of real equipment; this
 * is the subset the answer is allowed to come from. Kept as a filter of that
 * list rather than a second table, so the specs cannot drift apart.
 *
 * The consequence is deliberate and must not be softened: a spool that beats
 * a 20ft now reports **will not ship**, where before it quietly answered
 * "40ft HC". That is the useful answer -- it names a spool that has to be cut
 * differently, or shipped some other way, and the spool rules are what decide
 * which. A fit report that always finds something is not a report.
 *
 * Two numbers that follow from the 5,898mm usable length, both already
 * measured: a 6,000mm forced cut overruns it by 102mm and needs ANGLING, and
 * loaded square with a field weld the longest spool that still makes it is
 * 5,748mm.
 */
export const TWENTY_FOOT_CONTAINERS: ContainerSpec[] = STANDARD_CONTAINERS.filter((c) => c.name.startsWith("20ft"));

/** Excess pipe left at a field-adjusted joint, to be trimmed on site. */
export const FIELD_WELD_ALLOWANCE_MM = 150;

const sizes = (e: Envelope) => [e.lengthMm, e.widthMm, e.heightMm];

/** Every way of turning a box: 6 permutations of its three sides. */
function orientations(e: Envelope): Array<[number, number, number]> {
  const [a, b, c] = sizes(e);
  return [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ];
}

/**
 * The size actually shipped: the envelope plus a field-weld allowance where
 * one is needed.
 *
 * The allowance is extra pipe at ONE joint, so it lengthens the spool along
 * the axis that joint sits on. Where that axis is not known, `axis` is left
 * out and it is added to the LONGEST side -- the worst case, and the one that
 * decides a container fit, since the longest side is what runs up against the
 * container's length.
 */
export function shippingEnvelope(
  envelope: Envelope,
  opts: { fieldWelds?: number; axis?: "length" | "width" | "height"; allowanceMm?: number } = {}
): Envelope {
  const { fieldWelds = 0, axis, allowanceMm = FIELD_WELD_ALLOWANCE_MM } = opts;
  if (fieldWelds <= 0) return { ...envelope };
  const extra = allowanceMm * fieldWelds;
  const out = { ...envelope };
  if (axis === "width") out.widthMm += extra;
  else if (axis === "height") out.heightMm += extra;
  else if (axis === "length") out.lengthMm += extra;
  else {
    const longest = Math.max(out.lengthMm, out.widthMm, out.heightMm);
    if (out.lengthMm === longest) out.lengthMm += extra;
    else if (out.widthMm === longest) out.widthMm += extra;
    else out.heightMm += extra;
  }
  return out;
}

/** Finest yaw step searched, in degrees. */
const ANGLE_STEP_DEG = 0.05;

/**
 * Can the footprint `a` x `b` be swung to fit inside `L` x `W`?
 *
 * Rotating a rectangle by theta gives a bounding box of
 * (a.cos + b.sin) x (a.sin + b.cos), and the answer is the least theta where
 * both sides land inside. Sweeping 0..90 covers both ways round, since theta
 * and 90-theta swap the two sides.
 *
 * Only YAW is modelled -- swinging it flat on the floor. Tipping the spool up
 * as well would reach the container's full body diagonal (6,786mm in a 20ft
 * against 6,350mm across the floor), but that is not how heavy pipe is
 * loaded, so the extra is deliberately left on the table.
 */
function yawToFit(a: number, b: number, L: number, W: number): { angleDeg: number; clearanceMm: number } | null {
  let best: { angleDeg: number; clearanceMm: number } | null = null;
  for (let t = 0; t <= 90 + 1e-9; t += ANGLE_STEP_DEG) {
    const r = (t * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const clearance = Math.min(L - (a * cos + b * sin), W - (a * sin + b * cos));
    if (clearance < -1e-6) continue;
    // The angle with the MOST room, not the least swing. The shallowest angle
    // that works is by definition the one touching the end wall -- it came
    // out at 1mm of clearance on a 6,150mm spool, which is not a loading
    // instruction. A few degrees further over turns that into 44mm.
    if (!best || clearance > best.clearanceMm + 1e-9) best = { angleDeg: Number(t.toFixed(2)), clearanceMm: clearance };
  }
  return best;
}

/**
 * The size of the upright box a freely-rotated spool needs.
 *
 * Standard OBB-to-AABB: for rotation R and sides (a,b,c) the enclosing
 * box is sum_j |R_ij| * s_j along each axis i.
 *
 * This test is EXACT for a box, not conservative -- an earlier note here said
 * otherwise and it is worth correcting, because it invites someone to go
 * looking for slack that is not in the rotation maths. A convex body fits
 * inside a box exactly when its width along each of the box's three face
 * normals fits, and for a rotated box that width IS sum_j |R_ij| * s_j.
 *
 * What IS conservative is the BOX -- a spool is thin pipe tracing the edges of
 * its bounding box, mostly air, and a thin L can pass an opening its bounding
 * box cannot. Closing that gap needs the run's topology, which is not solved.
 * So the slack is in the model of the spool, never in the rotation.
 */
function rotatedExtent(a: number, b: number, c: number, yaw: number, pitch: number, roll: number): [number, number, number] {
  const ca = Math.cos(yaw);
  const sa = Math.sin(yaw);
  const cb = Math.cos(pitch);
  const sb = Math.sin(pitch);
  const cg = Math.cos(roll);
  const sg = Math.sin(roll);
  // R = Rz(yaw) . Ry(pitch) . Rx(roll)
  const r = [
    [ca * cb, ca * sb * sg - sa * cg, ca * sb * cg + sa * sg],
    [sa * cb, sa * sb * sg + ca * cg, sa * sb * cg - ca * sg],
    [-sb, cb * sg, cb * cg],
  ];
  return [
    Math.abs(r[0][0]) * a + Math.abs(r[0][1]) * b + Math.abs(r[0][2]) * c,
    Math.abs(r[1][0]) * a + Math.abs(r[1][1]) * b + Math.abs(r[1][2]) * c,
    Math.abs(r[2][0]) * a + Math.abs(r[2][1]) * b + Math.abs(r[2][2]) * c,
  ];
}

/**
 * Turn the spool in ALL THREE axes and find the attitude with the most room.
 *
 * Free rotation subsumes the axis permutations, so this is searched once
 * rather than per orientation. Coarse grid first, then refined around the
 * best -- a fine sweep of three angles is a million-point search and is not
 * worth it for an answer quoted to the millimetre.
 */
type ExtentAt = (yaw: number, pitch: number, roll: number) => [number, number, number];

function searchTiltWith(
  extentAt: ExtentAt,
  L: number,
  W: number,
  H: number
): { yawDeg: number; pitchDeg: number; rollDeg: number; clearanceMm: number } | null {
  const rad = (d: number) => (d * Math.PI) / 180;
  const score = (y: number, p: number, r: number) => {
    const [x, yy, z] = extentAt(rad(y), rad(p), rad(r));
    return Math.min(L - x, W - yy, H - z);
  };
  let best: { y: number; p: number; r: number; v: number } | null = null;
  const sweep = (y0: number, y1: number, p0: number, p1: number, r0: number, r1: number, step: number) => {
    for (let y = y0; y <= y1 + 1e-9; y += step)
      for (let p = p0; p <= p1 + 1e-9; p += step)
        for (let r = r0; r <= r1 + 1e-9; r += step) {
          const v = score(y, p, r);
          if (!best || v > best.v) best = { y, p, r, v };
        }
  };
  // THREE STAGES. Measured, because two looked sufficient: against the exact
  // limit found by bisection, the third stage is worth 1-4mm on a member laid
  // across the section (219mm thick: 3043 against 3047). That is small, and it
  // used to be below the noise -- but the result is now quoted as a near-miss
  // in single-digit millimetres, so a 4mm search error is the same size as the
  // answer. It costs about 17k extra evaluations per call.
  //
  // What it is NOT is a fix for knife-edge geometry. A 3260mm member does not
  // pass a 2340 x 2280 opening at any angle and no amount of refinement makes
  // it: the opening's diagonal is 3267, and the member's own thickness eats
  // the remaining 7mm. That was a guess, and bisecting for the true limit is
  // what disproved it -- the search had been right all along.
  sweep(0, 90, 0, 90, 0, 90, 3);
  if (!best) return null;
  const b0 = best as { y: number; p: number; r: number; v: number };
  sweep(b0.y - 3, b0.y + 3, b0.p - 3, b0.p + 3, b0.r - 3, b0.r + 3, 0.25);
  const b1 = best as { y: number; p: number; r: number; v: number };
  sweep(b1.y - 0.25, b1.y + 0.25, b1.p - 0.25, b1.p + 0.25, b1.r - 0.25, b1.r + 0.25, 0.02);
  const f = best as { y: number; p: number; r: number; v: number };
  return {
    yawDeg: Number(f.y.toFixed(1)),
    pitchDeg: Number(f.p.toFixed(1)),
    rollDeg: Number(f.r.toFixed(1)),
    clearanceMm: f.v,
  };
}

function searchTilt(a: number, b: number, c: number, L: number, W: number, H: number) {
  return searchTiltWith((y, p, r) => rotatedExtent(a, b, c, y, p, r), L, W, H);
}

/**
 * The same search, but keeping the answer when it is NEGATIVE.
 *
 * `tiltToFit` is a yes/no with an attitude attached; this is "how close did
 * the best attitude get", which is what turns "will not ship" into a number
 * somebody can act on.
 */
function bestTiltClearance(a: number, b: number, c: number, L: number, W: number, H: number): number | null {
  const t = searchTilt(a, b, c, L, W, H);
  return t ? t.clearanceMm : null;
}

/** The best attitude, but only if it actually fits. */
function tiltToFit(a: number, b: number, c: number, L: number, W: number, H: number) {
  const t = searchTilt(a, b, c, L, W, H);
  return t && t.clearanceMm >= -1e-6 ? t : null;
}

/**
 * How near a MISS still counts as "go and measure" rather than "no".
 *
 * The same reasoning as `MARGINAL_MM`, pointing the other way: container
 * internals vary between operators and build years by a few tens of mm, so a
 * spool that misses a NOMINAL spec by less than that has not been shown not
 * to fit. Reporting it as a flat no is a stronger claim than the specs
 * support, and it is the claim that sends someone away to re-cut a spool that
 * would have gone in.
 *
 * The same number as `MARGINAL_MM`, written out rather than referenced: that
 * one is declared further down this file, and a top-level const that reads
 * another one declared later blows up at module load. This file has no import
 * order to rely on, so it does not rely on one.
 */
export const NEAR_MISS_MM = 50;

/**
 * The same three questions as the box path -- square, swung, turned -- asked
 * of the RUN.
 *
 * Square is still worth asking first and reporting as `straight`: it is much
 * the easiest load, and the axis-aligned extents of the run are exactly the
 * envelope, so nothing is lost by trying it.
 */
function fitsAsRun(shape: SpoolShapeInput, container: ContainerSpec): FitResult {
  const { internal, door } = container;
  const extentAt = shapeExtentAt(shape);
  const square = extentAt(0, 0, 0);
  const box: Envelope = { lengthMm: square[0], widthMm: square[1], heightMm: square[2] };

  // SQUARE. Permuting the run's own bounding box is the same set of answers as
  // turning it by right angles, so the existing orientation logic serves.
  let best: { orientation: [number, number, number]; tightest: number } | null = null;
  for (const o of orientations(box)) {
    const [l, w, h] = o;
    if (l > internal.lengthMm || w > internal.widthMm || h > internal.heightMm) continue;
    if (door && (w > door.widthMm || h > door.heightMm)) continue;
    const gaps = [internal.lengthMm - l, internal.widthMm - w, internal.heightMm - h];
    if (door) gaps.push(door.widthMm - w, door.heightMm - h);
    const tightest = Math.min(...gaps);
    if (!best || tightest > best.tightest) best = { orientation: o, tightest };
  }
  if (best)
    return {
      container: container.name,
      fits: true,
      how: "straight",
      angleDeg: 0,
      orientation: best.orientation,
      tightestMm: Math.round(best.tightest),
      blockedBy: [],
    };

  // Can it get IN at all? Free-angle, travel direction unconstrained -- the
  // same separation the box path makes between passing the opening and
  // resting inside.
  const passesDoor = !door || searchTiltWith(extentAt, Number.POSITIVE_INFINITY, door.widthMm, door.heightMm) != null;

  if (passesDoor) {
    // SWUNG FLAT: yaw only, which is how heavy pipe is usually loaded.
    const flat = searchTiltWith(
      (y, _p, _r) => extentAt(y, 0, 0),
      internal.lengthMm,
      internal.widthMm,
      internal.heightMm
    );
    if (flat && flat.clearanceMm >= -1e-6)
      return {
        container: container.name,
        fits: true,
        how: "angled",
        angleDeg: flat.yawDeg,
        orientation: null,
        tightestMm: Math.round(flat.clearanceMm),
        blockedBy: [],
      };

    // TURNED IN ALL THREE.
    const t = searchTiltWith(extentAt, internal.lengthMm, internal.widthMm, internal.heightMm);
    if (t && t.clearanceMm >= -1e-6)
      return {
        container: container.name,
        fits: true,
        how: "tilted",
        angleDeg: t.yawDeg,
        tilt: { yawDeg: t.yawDeg, pitchDeg: t.pitchDeg, rollDeg: t.rollDeg },
        orientation: null,
        tightestMm: Math.round(t.clearanceMm),
        blockedBy: [],
      };
  }

  const blockedBy: string[] = [];
  if (!passesDoor) blockedBy.push(`the run will not pass the ${Math.round(door!.widthMm)} x ${Math.round(door!.heightMm)}mm opening at any angle`);
  const miss = passesDoor
    ? searchTiltWith(extentAt, internal.lengthMm, internal.widthMm, internal.heightMm)
    : null;
  const shortfallMm = miss && miss.clearanceMm < 0 ? Math.round(-miss.clearanceMm) : undefined;
  if (blockedBy.length === 0)
    blockedBy.push(
      `no attitude brings the run inside ${Math.round(internal.lengthMm)} x ${Math.round(internal.widthMm)} x ${Math.round(internal.heightMm)}mm`
    );
  if (shortfallMm != null && shortfallMm <= NEAR_MISS_MM)
    blockedBy.push(
      `misses by only ${shortfallMm}mm on a NOMINAL spec -- real containers vary by more than that, so measure the actual box before re-cutting this spool`
    );
  return {
    container: container.name,
    fits: false,
    how: null,
    angleDeg: null,
    orientation: null,
    tightestMm: null,
    blockedBy,
    ...(shortfallMm != null ? { shortfallMm } : {}),
  };
}

/**
 * The spool's REAL run, where it is known: its corners in plant millimetres
 * and the pipe's outside diameter.
 *
 * Given this, the fit is done on the run rather than on its bounding box, and
 * the difference is the whole point. A rotated BOX has eight corners and its
 * extent is sum_j |R_ij| * s_j; a rotated RUN has only the corners it actually
 * has, and the air between its legs rotates with it instead of sweeping.
 *
 * Still conservative, and in the safe direction: the test is on the convex
 * hull of the corners, grown by one pipe diameter. The spool lies inside that
 * hull, so a hull that fits means a spool that fits. What it does NOT model is
 * threading one spool's gaps through another's -- nobody loads pipe that way.
 */
export interface SpoolShapeInput {
  points: Array<[number, number, number]>;
  odMm: number;
}

/** The run's extent along each container axis, at one attitude. */
function shapeExtentAt(shape: SpoolShapeInput): ExtentAt {
  return (yaw, pitch, roll) => {
    const [ca, sa, cb, sb, cg, sg] = [
      Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll),
    ];
    const R = [
      [ca * cb, ca * sb * sg - sa * cg, ca * sb * cg + sa * sg],
      [sa * cb, sa * sb * sg + ca * cg, sa * sb * cg - ca * sg],
      [-sb, cb * sg, cb * cg],
    ];
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const q of shape.points) {
        const v = R[i][0] * q[0] + R[i][1] * q[1] + R[i][2] * q[2];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      // The pipe is round: its centreline sweeps a radius either side, so one
      // whole diameter across, on every axis.
      out[i] = hi - lo + shape.odMm;
    }
    return out;
  };
}

/** Does this envelope go into this container, turned any way at all? */
export function fitsContainer(envelope: Envelope, container: ContainerSpec, shape?: SpoolShapeInput): FitResult {
  const { internal, door } = container;
  // THE RUN BEATS THE BOX wherever the run is known. Everything below is the
  // bounding-box path, kept exactly as it was for the spools whose legs do not
  // chain -- a branch forks the walk and there is then no single run to use.
  if (shape && shape.points.length > 1) return fitsAsRun(shape, container);
  let best: { orientation: [number, number, number]; tightest: number } | null = null;

  for (const o of orientations(envelope)) {
    const [l, w, h] = o;
    if (l > internal.lengthMm || w > internal.widthMm || h > internal.heightMm) continue;
    // End-first through the door: the two cross-section sides must pass the
    // opening. Nothing to pass on a top-loaded container.
    if (door && (w > door.widthMm || h > door.heightMm)) continue;
    const gaps = [internal.lengthMm - l, internal.widthMm - w, internal.heightMm - h];
    if (door) gaps.push(door.widthMm - w, door.heightMm - h);
    const tightest = Math.min(...gaps);
    if (!best || tightest > best.tightest) best = { orientation: o, tightest };
  }

  if (best)
    return {
      container: container.name,
      fits: true,
      how: "straight",
      angleDeg: 0,
      orientation: best.orientation,
      tightestMm: best.tightest,
      blockedBy: [],
    };

  // Nothing square fits. Swing it across the floor: pick each side in turn to
  // stand vertical, and yaw the other two.
  //
  // GETTING IN AND SITTING DOWN ARE TWO DIFFERENT QUESTIONS, and conflating
  // them is wrong in both directions.
  //
  // The old gate asked whether the two smallest sides passed the opening
  // SQUARELY, which threw away spools that go in turned. Capping the resting
  // attitude by the door instead is wrong the other way: a 6.5m stick of pipe
  // enters end-on, easily, and is then tilted onto the body diagonal INSIDE
  // the box -- the door never sees that attitude at all.
  //
  // So: can it pass the opening at SOME attitude (free-angle, travel
  // direction unconstrained -- that is what the infinite length means), and
  // separately, can it rest at some attitude that fits the body. A fat spool
  // is still refused, because a box whose two larger sides both beat the
  // opening has no rotation that shrinks them: turning a rectangle only ever
  // grows its bounding box.
  const [sa, sb, sc] = sizes(envelope);
  const passesDoor = !door || tiltToFit(sa, sb, sc, Number.POSITIVE_INFINITY, door.widthMm, door.heightMm) != null;

  let swung: { orientation: [number, number, number]; angle: number; tightest: number } | null = null;
  for (const o of orientations(envelope)) {
    const [a, b, v] = o;
    if (v > internal.heightMm || !passesDoor) continue;
    const yaw = yawToFit(a, b, internal.lengthMm, internal.widthMm);
    if (yaw == null) continue;
    const tightest = Math.min(yaw.clearanceMm, internal.heightMm - v);
    // REPORT THE ANGLE OFF THE CONTAINER'S LENGTH, not off whichever side the
    // permutation happened to call `a`. Swapping a and b describes the same
    // physical swing as theta and 90-theta, and the two tie on clearance to
    // the millimetre -- so which one got printed came down to loop order, and
    // a 6m spool's modest 19 degree swing was being reported as 71.
    const angle = a >= b ? yaw.angleDeg : Number((90 - yaw.angleDeg).toFixed(2));
    if (!swung || tightest > swung.tightest) swung = { orientation: o, angle, tightest };
  }
  if (swung)
    return {
      container: container.name,
      fits: true,
      how: "angled",
      angleDeg: swung.angle,
      orientation: swung.orientation,
      tightestMm: Math.round(swung.tightest),
      blockedBy: [],
    };

  // Flat on the floor is not enough. Turn it in all three axes, which reaches
  // the container's body diagonal rather than just its floor diagonal.
  //
  // THE DOOR GATE USED TO BE AXIS-ALIGNED, and it threw away real fits. It
  // sorted the three sides and asked whether the two smallest passed the
  // opening squarely -- so a spool that goes in turned simply never reached
  // the rotation search. N-16 is the case: 5580 x 2795 planar, whose 2795 leg
  // lies comfortably along the container's cross-section DIAGONAL (2352 and
  // 2393 give 3355mm, Pythagoras) at about 45 degrees, presenting 1976 x 1976
  // to a 2340 x 2280 opening. The old gate compared 2795 against 2340, said
  // no, and never looked.
  //
  // Folding the opening into the SAME search fixes it: the attitude that fits
  // the body is the attitude the door sees.
  if (passesDoor) {
    const t = tiltToFit(sa, sb, sc, internal.lengthMm, internal.widthMm, internal.heightMm);
    if (t) {
      return {
        container: container.name,
        fits: true,
        how: "tilted",
        angleDeg: t.yawDeg,
        tilt: { yawDeg: t.yawDeg, pitchDeg: t.pitchDeg, rollDeg: t.rollDeg },
        orientation: [sa, sb, sc],
        tightestMm: Math.round(t.clearanceMm),
        blockedBy: [],
      };
    }
  }

  // Say WHY. Once angling has been tried, "longer than the container" is the
  // wrong thing to report -- a spool longer than the floor still goes in
  // across the diagonal, so the real limits are the diagonal and the
  // cross-section that has to swing past the side walls.
  const spool = sizes(envelope).sort((a, b) => b - a);
  const space = sizes(internal).sort((a, b) => b - a);
  const diagonal = Math.hypot(internal.lengthMm, internal.widthMm);
  const blockedBy: string[] = [];
  const body = Math.hypot(internal.lengthMm, internal.widthMm, internal.heightMm);
  if (spool[0] > body) {
    blockedBy.push(`longest side ${Math.round(spool[0])}mm over the ${Math.round(body)}mm body diagonal -- no attitude fits`);
  } else if (spool[0] > diagonal) {
    // Under the body diagonal, so length alone did not defeat it -- the
    // section did, by sweeping too wide as it comes off the floor.
    blockedBy.push(
      `longest side ${Math.round(spool[0])}mm over the ${Math.round(diagonal)}mm floor diagonal, and its ${Math.round(spool[1])}mm section is too big to tilt through the ${Math.round(body)}mm body diagonal`
    );
  } else if (spool[0] > internal.lengthMm) {
    blockedBy.push(
      `longest side ${Math.round(spool[0])}mm needs angling, and its ${Math.round(spool[1])}mm cross-section will not swing inside ${Math.round(internal.widthMm)}mm`
    );
  }
  const names = ["longest", "middle", "shortest"];
  for (let i = 1; i < 3; i++) {
    if (spool[i] > space[i]) blockedBy.push(`${names[i]} side ${Math.round(spool[i])}mm over ${Math.round(space[i])}mm`);
  }
  if (blockedBy.length === 0 && door) {
    const cross = spool.slice(1).sort((a, b) => b - a);
    const opening = [door.widthMm, door.heightMm].sort((a, b) => b - a);
    for (let i = 0; i < 2; i++) {
      if (cross[i] > opening[i]) blockedBy.push(`will not pass the door: ${Math.round(cross[i])}mm against a ${Math.round(opening[i])}mm opening`);
    }
  }
  if (blockedBy.length === 0) blockedBy.push("no angle across the floor brings it inside");

  // HOW CLOSE DID IT GET? The reasons above say which limit was hit; they do
  // not say by how much, and a 6mm miss is not the same answer as a 3-metre
  // one. Only worth computing where the opening is not the blocker -- a
  // spool that cannot pass the door does not get closer by being tilted
  // inside a box it never enters.
  const missBy = passesDoor ? bestTiltClearance(sa, sb, sc, internal.lengthMm, internal.widthMm, internal.heightMm) : null;
  const shortfallMm = missBy != null && missBy < 0 ? Math.round(-missBy) : undefined;
  if (shortfallMm != null && shortfallMm <= NEAR_MISS_MM) {
    blockedBy.push(
      `misses by only ${shortfallMm}mm on a NOMINAL spec -- real containers vary by more than that, so measure the actual box before re-cutting this spool`
    );
  }
  return {
    container: container.name,
    fits: false,
    how: null,
    angleDeg: null,
    orientation: null,
    tightestMm: null,
    blockedBy,
    ...(shortfallMm != null ? { shortfallMm } : {}),
  };
}

export interface SpoolFit {
  spool: string;
  envelope: Envelope;
  /** The envelope actually shipped, after any field-weld allowance. */
  shipping: Envelope;
  fieldWelds: number;
  results: FitResult[];
  /** The smallest container it goes in at all, angling allowed. */
  smallest: FitResult | null;
  /**
   * The smallest it goes in SQUARE. Often a size up from `smallest`, and
   * worth having both: "a 40ft if you load it straight, or a 20ft if you are
   * willing to swing it" is the actual decision, and it is not ours to make.
   */
  smallestStraight: FitResult | null;
  /** Within this of not fitting -- container sizes vary, so check the real one. */
  marginal: boolean;
}

/** How close a fit has to be before the answer is "go and measure", in mm. */
export const MARGINAL_MM = 50;

export function checkSpoolFit(
  spool: string,
  envelope: Envelope,
  opts: {
    fieldWelds?: number;
    axis?: "length" | "width" | "height";
    containers?: ContainerSpec[];
    allowanceMm?: number;
    /**
     * The spool's real run, where its legs chained. Given this, the fit is
     * done on the run instead of on its bounding box -- see `fitsAsRun`. The
     * field-weld allowance is already in it: it is pipe left on the end, so
     * the run is carried that much further rather than the box fattened.
     */
    shape?: SpoolShapeInput;
  } = {}
): SpoolFit {
  const containers = opts.containers ?? STANDARD_CONTAINERS;
  const shipping = shippingEnvelope(envelope, opts);
  const results = containers.map((c) => fitsContainer(shipping, c, opts.shape));
  // "Smallest" means cheapest to ship, not least cubic metres: an ordinary
  // dry box always beats special equipment, and only then does size decide.
  // Ranking on volume alone answered "20ft open top" for a spool a plain 20ft
  // takes, because the open top's roof rails cost it 46mm of height.
  const specOf = (n: string) => containers.find((x) => x.name === n)!;
  const fitting = results
    .filter((r) => r.fits)
    .sort((a, b) => {
      const ca = specOf(a.container);
      const cb = specOf(b.container);
      if (!!ca.special !== !!cb.special) return ca.special ? 1 : -1;
      const vol = (c: ContainerSpec) => c.internal.lengthMm * c.internal.widthMm * c.internal.heightMm;
      return vol(ca) - vol(cb);
    });
  const smallest = fitting[0] ?? null;
  const smallestStraight = fitting.find((r) => r.how === "straight") ?? null;
  return {
    spool,
    envelope,
    shipping,
    fieldWelds: opts.fieldWelds ?? 0,
    results,
    smallest,
    smallestStraight,
    marginal: smallest != null && smallest.tightestMm != null && smallest.tightestMm < MARGINAL_MM,
  };
}
