import {
  checkSpoolFit,
  FIELD_WELD_ALLOWANCE_MM,
  MARGINAL_MM,
  NEAR_MISS_MM,
  TWENTY_FOOT_CONTAINERS,
  withFieldWeldAllowance,
  type FitResult,
  type SpoolFit,
} from "@easy/shared";
import type { ContainerSpool } from "@/lib/containers";

// The container check for one spool, and for a set of them.
//
// This used to live inside the ContainerFit component, which is right for the
// table but leaves nothing for anything else to call. A line's summary has to
// give the same answer as that table, so the answer is computed here, once, and
// both read it. Pure and free of server imports, so the client component can
// use it too.

/** How the three axes map onto the fit check's own length/width/height. */
const AXIS_SIDE = { "UP-DOWN": "length", "N-S": "width", "E-W": "height" } as const;

/**
 * Which side the field weld's 150mm of excess pipe belongs on.
 *
 * A field weld is a real place on the run, so the slack it needs lies along
 * the axis the pipe runs at that point -- found by the length that attaches
 * to that very weld. Falling back to the LONGEST side, which is what the
 * check does when the direction is unknown, is the worst case rather than
 * the answer: on N-02 the field weld is on the N-S leg, not the 3437mm
 * east one.
 */
export function fieldWeldSide(s: ContainerSpool): "length" | "width" | "height" | undefined {
  if (!s.envelope || s.fieldWeldNumbers.length === 0) return undefined;
  for (const [axis, parts] of Object.entries(s.envelope.parts) as Array<
    [keyof typeof AXIS_SIDE, Array<{ weldNo?: number; weldNos?: number[] }>]
  >) {
    // EVERY weld the length reaches, not just the one it is keyed by. A
    // length ending AT its spool's closing weld is keyed by the weld at its
    // other end: N-02's 881 is keyed 11 while the field weld it runs to is
    // 12, so matching on the key alone found nothing and the 150mm went to
    // the longest side -- 3437 east -- instead of the N-S leg carrying the
    // weld.
    const touches = (p: { weldNo?: number; weldNos?: number[] }) =>
      (p.weldNos ?? (p.weldNo != null ? [p.weldNo] : [])).some((n) => s.fieldWeldNumbers.includes(n));
    if (parts.some(touches)) return AXIS_SIDE[axis];
  }
  return undefined;
}

/**
 * The container it ALMOST goes in, when none takes it outright.
 *
 * A spool over a nominal internal size by less than containers vary between
 * operators has not been shown not to fit -- it has been shown to need a tape
 * measure. N-10 carrying its field-weld allowance is the case: 6150 x 721 x
 * 457 against a 20ft, missing by single-digit millimetres on a spec quoted to
 * the nearest millimetre and built to rather less than that.
 */
export function nearMiss(fit: SpoolFit): FitResult | null {
  const close = fit.results
    .filter((r) => !r.fits && r.shortfallMm != null && r.shortfallMm <= NEAR_MISS_MM)
    .sort((a, b) => a.shortfallMm! - b.shortfallMm!);
  return close[0] ?? null;
}

/** Marginal against the container it was answered for: within MARGINAL_MM of the limit means "confirm", not "yes". */
export const isTight = (r: FitResult | null) => r != null && r.tightestMm != null && r.tightestMm < MARGINAL_MM;

/**
 * How one spool fits, or null when no size was read for it -- a zero extent is
 * a real answer (a straight piece), an absent one is not.
 */
export function fitOf(s: ContainerSpool): SpoolFit | null {
  const e = s.envelope;
  if (!e) return null;
  return checkSpoolFit(
    s.spoolNo,
    { lengthMm: e.upDownMm, widthMm: e.nsMm, heightMm: e.ewMm },
    // TWENTY FOOT ONLY. A spool that beats a 20ft reports "will not ship" rather
    // than being answered with a 40ft: that is a spool to cut differently, and
    // saying so is the point.
    //
    // And the RUN where it is known, so the check is done on the pipe rather
    // than on the box around it. The field-weld excess goes onto the run itself
    // -- it is pipe left on the end.
    {
      fieldWelds: s.fieldWelds,
      axis: fieldWeldSide(s),
      containers: TWENTY_FOOT_CONTAINERS,
      shape:
        e.shape && s.pipeOdMm != null
          ? {
              points: withFieldWeldAllowance(e.shape as never, FIELD_WELD_ALLOWANCE_MM * s.fieldWelds).points,
              odMm: s.pipeOdMm,
            }
          : undefined,
    }
  );
}

export interface FitSummary {
  /** Spools in the set. */
  total: number;
  /** Spools with a size read off the drawing -- the only ones that can be checked. */
  sized: number;
  /** Fit a 20ft container. */
  ship: number;
  /** Of those, within MARGINAL_MM of the limit: confirm against the actual box. */
  marginal: number;
  /** Do not fit, but by less than containers vary between operators: measure the actual box. */
  nearMiss: number;
  /** Do not fit. */
  noFit: number;
  /** Spools carrying a field weld, so shipped 150mm longer. */
  withFieldWelds: number;
}

/** The counts ContainerFit's header shows, for a set of spools -- with turning allowed, as the page starts. */
export function summariseFits(spools: ContainerSpool[], allowTurning = true): FitSummary {
  let sized = 0;
  let ship = 0;
  let marginal = 0;
  let near = 0;
  let noFit = 0;
  for (const spool of spools) {
    const fit = fitOf(spool);
    if (!fit) continue;
    sized += 1;
    const best = allowTurning ? fit.smallest : fit.smallestStraight;
    if (best) {
      ship += 1;
      if (isTight(best)) marginal += 1;
    } else if (nearMiss(fit)) near += 1;
    else noFit += 1;
  }
  return {
    total: spools.length,
    sized,
    ship,
    marginal,
    nearMiss: near,
    noFit,
    withFieldWelds: spools.filter((s) => s.fieldWelds > 0).length,
  };
}
