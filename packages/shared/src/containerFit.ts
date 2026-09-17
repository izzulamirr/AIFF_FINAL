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
 * box is sum_j |R_ij| * s_j along each axis i. Note this is CONSERVATIVE --
 * the spool's own bounding box fitting is sufficient for the spool to fit,
 * never the other way round -- which is the safe direction for a shipping
 * answer. For a long thin run of pipe the two are nearly the same thing.
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
function tiltToFit(
  a: number,
  b: number,
  c: number,
  L: number,
  W: number,
  H: number
): { yawDeg: number; pitchDeg: number; rollDeg: number; clearanceMm: number } | null {
  const rad = (d: number) => (d * Math.PI) / 180;
  const score = (y: number, p: number, r: number) => {
    const [x, yy, z] = rotatedExtent(a, b, c, rad(y), rad(p), rad(r));
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
  sweep(0, 90, 0, 90, 0, 90, 3);
  if (!best) return null;
  const b0 = best as { y: number; p: number; r: number; v: number };
  sweep(b0.y - 3, b0.y + 3, b0.p - 3, b0.p + 3, b0.r - 3, b0.r + 3, 0.25);
  const f = best as { y: number; p: number; r: number; v: number };
  if (f.v < -1e-6) return null;
  return {
    yawDeg: Number(f.y.toFixed(1)),
    pitchDeg: Number(f.p.toFixed(1)),
    rollDeg: Number(f.r.toFixed(1)),
    clearanceMm: f.v,
  };
}

/** Does this envelope go into this container, turned any way at all? */
export function fitsContainer(envelope: Envelope, container: ContainerSpec): FitResult {
  const { internal, door } = container;
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
  let swung: { orientation: [number, number, number]; angle: number; tightest: number } | null = null;
  for (const o of orientations(envelope)) {
    const [a, b, v] = o;
    if (v > internal.heightMm) continue;
    // It still has to get IN. Whatever the load angle ends up being, the
    // spool goes through the opening end-on, so its cross-section must pass.
    if (door && (Math.min(a, b) > door.widthMm || v > door.heightMm)) continue;
    const yaw = yawToFit(a, b, internal.lengthMm, internal.widthMm);
    if (yaw == null) continue;
    const tightest = Math.min(yaw.clearanceMm, internal.heightMm - v);
    if (!swung || tightest > swung.tightest) swung = { orientation: o, angle: yaw.angleDeg, tightest };
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
  const [sa, sb, sc] = sizes(envelope);
  const cross = sizes(envelope).sort((x, y) => x - y);
  const doorOk = !door || (cross[0] <= door.widthMm && cross[1] <= door.heightMm) || (cross[0] <= door.heightMm && cross[1] <= door.widthMm);
  if (doorOk) {
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
  return { container: container.name, fits: false, how: null, angleDeg: null, orientation: null, tightestMm: null, blockedBy };
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
  } = {}
): SpoolFit {
  const containers = opts.containers ?? STANDARD_CONTAINERS;
  const shipping = shippingEnvelope(envelope, opts);
  const results = containers.map((c) => fitsContainer(shipping, c));
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
