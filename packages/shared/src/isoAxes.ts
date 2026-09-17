// The PLANT axes behind an isometric's three drawn directions.
//
// An isometric is drawn on three axes 120 degrees apart on the page, and each
// one is a real direction in the plant:
//
//   page 270 (straight up)  ->  UP / DOWN      -- elevation, always
//   the other two           ->  N / S and E / W, which way round being fixed
//                               by the sheet's NORTH ARROW
//
// Vertical needs no arrow: an isometric never tilts the elevation axis, so a
// dimension drawn at 90 degrees on the page is a rise or a drop and nothing
// else. That is the part worth relying on -- a spool's height is the one
// extent that can be named with no reference to the sheet at all.
//
// The two horizontals DO need the arrow, and naming them the wrong way round
// swaps N-S with E-W. Note what that does and does not affect: a shipping
// ENVELOPE is three extents, and swapping the labels of two of them leaves
// the set of three unchanged -- so a container answer is unaffected by
// getting the arrow wrong. It is the REPORTING that needs the arrow right.

/** One of the six directions a piece of pipe can run in the plant. */
export type PlantDirection = "N" | "S" | "E" | "W" | "UP" | "DOWN";

/** The axis a run lies on, ignoring which way along it the pipe goes. */
export type PlantAxis = "N-S" | "E-W" | "UP-DOWN";

export interface IsoFrame {
  /**
   * Page angle that plant NORTH projects to, in degrees clockwise from
   * "right", because page y runs DOWN: 0 right, 90 down, 180 left, 270 up.
   * On an isometric this is one of 30, 150, 210, 330.
   */
  northPageDeg: number;
  /**
   * Which of the two remaining horizontal rays is EAST. This is the drawing's
   * handedness and cannot be inferred from the arrow alone -- the same arrow
   * appears on sheets drawn from either side.
   *
   * There is no fixed offset to apply here. An isometric has SIX rays -- two
   * horizontal axes (30/210 and 150/330) and the vertical (90/270) -- so
   * given north, the E-W axis is already decided: it is the other horizontal
   * pair. Exactly one of north+120 and north+240 lands on it, the other
   * lands on the vertical, where no horizontal run can go. All this flag
   * chooses is which END of that axis is east.
   */
  eastIsClockwise: boolean;
}

/**
 * The reference ISO's frame, fixed against a RUN WHOSE DIRECTION IS KNOWN.
 *
 * Sheet 1's 80mm weldolet branch -- the one its 404mm dimension spans -- is
 * drawn at page 150 degrees, down and to the left, and it runs WEST. That
 * puts west at 150 and east at 330, so north and south are the OTHER
 * horizontal axis: north 210 (up-left), south 30 (down-right).
 *
 * Reading a run off the drawing beats reading the arrow, and is how this was
 * settled after two wrong guesses:
 *
 *  - the arrow symbol was never found in the geometry at all (below)
 *  - "WOL 200X80 NS" beside that very weldolet was read as "north side". It
 *    is NEAR SIDE -- which side of the pipe the olet sits on in the view --
 *    and means nothing about the compass. FS is the other one. Do not treat
 *    NS/FS as direction evidence.
 *
 * The independent check that agrees: sheet 1's valve carries a
 * "VALVE_WRENCH SOUTH" note and its wrench is drawn toward page 30, giving
 * south at 30 and north at 210 by a different route entirely.
 *
 * NOT auto-detected. Three geometric searches for the arrow -- isolated
 * filled shapes, small boxes containing a filled shape, and large filled
 * triangles -- returned callout balloons, BOM boxes and the company logo.
 * The consequence is bounded: the frame changes what the axes are CALLED,
 * not what a container answer is.
 */
export const DEFAULT_ISO_FRAME: IsoFrame = { northPageDeg: 210, eastIsClockwise: true };

/** Page angle normalised to [0, 360). */
const norm360 = (deg: number) => ((deg % 360) + 360) % 360;
/** Smallest turn between two page angles, 0..180. */
const apart = (a: number, b: number) => {
  const d = Math.abs(norm360(a) - norm360(b));
  return Math.min(d, 360 - d);
};

/** How far off a drawn direction is from the nearest plant direction. */
export const AXIS_TOLERANCE_DEG = 8;

/** Page angle of each plant direction under this frame. */
/** The rays an isometric actually draws: two horizontal axes and the vertical. */
export const HORIZONTAL_RAYS = [30, 150, 210, 330];
const isHorizontalRay = (deg: number) => HORIZONTAL_RAYS.some((r) => apart(deg, r) <= AXIS_TOLERANCE_DEG);

export function directionAngles(frame: IsoFrame = DEFAULT_ISO_FRAME): Record<PlantDirection, number> {
  const north = norm360(frame.northPageDeg);
  // Whichever of +120 / +240 stays on a horizontal axis is the E-W one.
  const eBase = isHorizontalRay(north + 120) ? north + 120 : north + 240;
  const east = norm360(frame.eastIsClockwise ? eBase : eBase + 180);
  return { N: north, S: norm360(north + 180), E: east, W: norm360(east + 180), UP: 270, DOWN: 90 };
}

/**
 * Which way does a run drawn in this page direction actually go?
 *
 * `pageDeg` is a DIRECTED angle -- 0 right, 90 down, 180 left, 270 up -- so a
 * segment and its reverse give opposite answers, which is the point.
 * Null when it lies on no drawn axis, which usually means it is not pipe.
 */
export function plantDirection(pageDeg: number, frame: IsoFrame = DEFAULT_ISO_FRAME): PlantDirection | null {
  const angles = directionAngles(frame);
  let best: { dir: PlantDirection; off: number } | null = null;
  for (const [dir, deg] of Object.entries(angles) as Array<[PlantDirection, number]>) {
    const off = apart(pageDeg, deg);
    if (!best || off < best.off) best = { dir, off };
  }
  return best && best.off <= AXIS_TOLERANCE_DEG ? best.dir : null;
}

/** Page angle of a vector, in the same convention (y down). */
export const pageAngleOf = (from: { x: number; y: number }, to: { x: number; y: number }) =>
  norm360((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);

const AXIS_OF: Record<PlantDirection, PlantAxis> = {
  N: "N-S",
  S: "N-S",
  E: "E-W",
  W: "E-W",
  UP: "UP-DOWN",
  DOWN: "UP-DOWN",
};

/**
 * Which axis a run lies on, from an UNDIRECTED page angle (0-180) -- which is
 * what a dimension gives, since a dimension has no direction of travel.
 */
export function plantAxis(pageDegUndirected: number, frame: IsoFrame = DEFAULT_ISO_FRAME): PlantAxis | null {
  const d = plantDirection(pageDegUndirected, frame) ?? plantDirection(pageDegUndirected + 180, frame);
  return d ? AXIS_OF[d] : null;
}

/**
 * Compass BEARING of a plant direction, with NORTH AS ZERO.
 *
 * This is the frame everything is reported in: north 0, east 90, south 180,
 * west 270, measured in the plant and not on the page. The page angles above
 * are an artefact of how the sheet happens to be drawn -- two drawings of the
 * same run with different north arrows give different page angles and the
 * same bearings, which is the point of having the arrow at all.
 *
 * UP and DOWN have no bearing: they are off the compass entirely, which is
 * why elevation is carried as its own axis rather than as a third angle.
 */
export const BEARING_OF: Record<PlantDirection, number | null> = {
  N: 0,
  E: 90,
  S: 180,
  W: 270,
  UP: null,
  DOWN: null,
};

/** Bearing of a run drawn in this page direction, north being zero. */
export function plantBearing(pageDeg: number, frame: IsoFrame = DEFAULT_ISO_FRAME): number | null {
  const d = plantDirection(pageDeg, frame);
  return d ? BEARING_OF[d] : null;
}

export const axisOfDirection = (d: PlantDirection): PlantAxis => AXIS_OF[d];
