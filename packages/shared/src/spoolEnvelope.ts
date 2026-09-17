// A spool's overall size, worked out from the dimensions printed on the sheet.
//
// Each printed length is tied to a spool by WHERE IT ATTACHES TO THE PIPE. A
// dimension is drawn parallel to what it measures and offset from it, both
// ends by the same amount, so sliding it back along its witness direction
// lands it on the run -- and the run it lands on says which spool it belongs
// to. The worker does that slide (`pipeAttachment` in isoDimensions) because
// it has the drawing's geometry; this file decides what the result means.
//
// Verified against N-01 of the reference ISO, which is 588mm down and 404mm
// west: it returns 202 + 202 + 184 down and 404 west, and rejects the three
// lengths that do not belong (two 464mm valve assemblies and a 210mm one).
import { pageAngleOf, plantAxis, plantDirection, type IsoFrame, type PlantAxis, type PlantDirection } from "./isoAxes";

type Pt = { x: number; y: number };

/** Where a dimension meets the pipe it measures, as the worker found it. */
export interface PipeAttachment {
  from: Pt;
  to: Pt;
  /** Fraction of the span with pipe drawn under it, 0..1. */
  coverage: number;
}

export interface DimensionInput {
  /** Stable id, "<page>-<n>", so a reading traces back to a place on a sheet. */
  cell: string;
  page: number;
  from: Pt;
  to: Pt;
  /** The length read off the drawing. Null where it could not be read. */
  mm: number | null;
  /** Undirected page angle, 0-180. */
  degrees: number;
  /** Page angle of the witness lines, which is how it reaches the pipe. */
  witnessDegrees: number | null;
  /** The two points on the run this length brackets. Null if not found. */
  attach?: PipeAttachment | null;
  /**
   * What the sheet PRINTS, where `mm` has been corrected away from it.
   *
   * A printed length can measure more pipe than the spool owns. Sheet 1's
   * 1186 runs from the elbow PAST the field weld at weld 12, and the drawing
   * prints the 305mm overshoot as its own dimension -- so the spool's share
   * is 881. That cannot be worked out by scaling: 305mm spans 21pt while
   * 1186mm spans 108pt on the same run, so the page is not linear even
   * along one piece of pipe. It has to be read, and until the reader finds
   * that dimension it is corrected by hand, with the reason recorded.
   */
  printedMm?: number | null;
  /** Why `mm` differs from what is printed. Required with `printedMm`. */
  correctionWhy?: string | null;
}

export interface WeldInput {
  page: number;
  weldNo: number;
  mark: Pt;
}

export interface SpoolAssignmentInput {
  page: number;
  weldNo: number;
  spool: string;
}

/**
 * How much pipe must lie under a dimension for it to be measuring pipe.
 *
 * A spool is what is WELDED together. A valve is bolted in between two
 * flanges and ships on its own, so a dimension spanning one brackets no pipe
 * at all -- and that is the test for whether a printed length is part of a
 * spool's size.
 *
 * Deliberately a loose cutoff, because what it judges is not a close call.
 * On the reference ISO the two populations do not overlap or even approach
 * each other: every length drawn over a run scores 46% or more, every one
 * spanning a bolted-in valve scores exactly 0%, and nothing lands between.
 * That includes all eight of the 464mm valve assemblies, which recur across
 * four sheets and are rejected every time -- so the rule is reading a gap in
 * the drawing rather than being tuned to one sheet of it. Anything from 5%
 * to 40% gives the same answer.
 */
export const MIN_PIPE_COVERAGE = 0.2;

/**
 * How far an attachment point may sit from the weld that names its spool.
 *
 * Generous on purpose. What guards this is not the radius but the two ends
 * AGREEING: a length lying on pipe whose ends both point at the same spool
 * is in that spool, however far the nearest weld happens to be. Weld
 * tracing leaves real holes -- sheet 1's welds 5 and 9 both have untraced
 * leaders -- and a tight radius turns every such hole into a dropped
 * length. Sheet 1's 1000mm run sits between welds 8 and 10 with weld 9
 * missing, about 100pt from either.
 */
const NEAR_WELD_PT = 150;
/**
 * How close the ONE end must be when it is deciding alone.
 *
 * An end can legitimately land on something that is not a weld -- the start
 * of the run, an elbow, a tie-in continuing onto another sheet, or a weld
 * whose leader could not be traced (sheet 1 has two). So a single matched
 * end is accepted, but only a firm one, and only when the other end reaches
 * no weld at all: an end that reaches a DIFFERENT spool is a crossing, not a
 * free end, and is handled as one.
 */
const SOLE_WELD_PT = 30;

/** One length that went into a total, with everything needed to check it. */
export interface EnvelopePart {
  /** "<page>-<n>" -- find it on the dimension contact sheet. */
  cell: string;
  mm: number;
  /**
   * Which of the six the dimension is DRAWN along. A dimension has no flow
   * direction -- it brackets an extent without saying which way the pipe
   * runs -- so this is the sense the draughtsman happened to draw it in, not
   * a fact about the pipe. Useful for splitting a total six ways to eyeball
   * it; never use it to decide whether a run doubles back.
   */
  drawnAs: PlantDirection;
  /**
   * The weld this length was matched to, which is how it ended up in this
   * spool. THIS is the field that exposes a bad grouping: a length whose
   * weld sits in the neighbouring spool is the one that does not belong.
   */
  weldNo: number;
  /** What the sheet prints, where `mm` was corrected away from it. */
  printedMm?: number;
  /** Why. Shown beside the length, so a correction is never invisible. */
  correctionWhy?: string;
  /**
   * Set where the length runs PAST this spool's boundary weld, so part of
   * what it measures belongs to the next spool. The figure is in POINTS, not
   * mm: the page is not to scale, so the millimetres have to be read off the
   * drawing. An uncorrected overshoot means the total is an over-estimate.
   */
  overshootPt?: number;
  /** The boundary weld it runs past. */
  overshootWeldNo?: number;
}

/** How far off a length's own line a weld may sit and still be ON it. */
const ON_LINE_PT = 25;
/**
 * Smaller than this and running past a weld means nothing.
 *
 * A dimension normally ends at the FITTING -- the flange face, the end of the
 * pipe -- not at the weld dot a few points inside it, so a small overshoot is
 * the ordinary case and not a defect. Measured across the reference ISO the
 * two groups separate cleanly, with nothing between 11.9 and 18.2:
 *
 *   ordinary:  6.8  7.0  7.1  7.2  8.9  10.2  10.2  10.5  11.9  11.9  11.9
 *   real:                          18.2  18.2  19.1  20.0  20.7  21.3
 *
 * N-01's verified 588 is what pins the bottom of that: its 202mm runs 7pt
 * past weld 6 and must NOT be docked for it. Sheet 1's 1186, the one that
 * genuinely runs past the field weld, is 20.
 */
const MIN_OVERSHOOT_PT = 15;

/**
 * Does this length run PAST the end of the spool it was placed in?
 *
 * A spool ends at its boundary weld, but a dimension does not have to: sheet
 * 1's 1186 runs from the elbow past the field weld at weld 12 and on to the
 * end of the next piece, so 305mm of what it measures belongs to the spool
 * after this one. Adding it whole overstates the spool, which is the UNSAFE
 * direction for a shipping answer.
 *
 * The test is positional and needs no scale: project the spool's own
 * boundary weld onto the length's line, and if it lands strictly INSIDE the
 * span then the pipe beyond it is not this spool's. How much that is in mm
 * cannot be worked out here -- the drawing is not to scale even along one
 * piece of pipe, where 305mm spans 21pt beside 1186mm spanning 108pt -- so
 * this reports the overshoot and leaves the number to be read. What it
 * guarantees is that such a length can never quietly inflate a spool.
 */
function overshootPt(
  attach: PipeAttachment,
  spool: string,
  welds: WeldInput[],
  spoolOf: (weldNo: number) => string | undefined
): { pt: number; weldNo: number } | null {
  const len = dist(attach.from, attach.to);
  if (len < 1) return null;
  const u = { x: (attach.to.x - attach.from.x) / len, y: (attach.to.y - attach.from.y) / len };
  let worst: { pt: number; weldNo: number } | null = null;
  for (const w of welds) {
    if (spoolOf(w.weldNo) !== spool) continue;
    // A BOUNDARY weld: the run changes spool on one side of it.
    const after = spoolOf(w.weldNo + 1);
    const before = spoolOf(w.weldNo - 1);
    if ((after === undefined || after === spool) && (before === undefined || before === spool)) continue;
    const dx = w.mark.x - attach.from.x;
    const dy = w.mark.y - attach.from.y;
    if (Math.abs(dx * u.y - dy * u.x) > ON_LINE_PT) continue; // not on this length's line
    const t = dx * u.x + dy * u.y;
    if (t <= 0 || t >= len) continue; // the weld is at or outside an end: no overshoot
    const beyond = Math.min(t, len - t);
    if (beyond >= MIN_OVERSHOOT_PT && (!worst || beyond > worst.pt)) {
      worst = { pt: Number(beyond.toFixed(1)), weldNo: w.weldNo };
    }
  }
  return worst;
}

/** A length that measures pipe but could not be put in one spool. */
export interface UnplacedLength {
  cell: string;
  page: number;
  mm: number;
  /** "no pipe" (spans a bolted joint), "no weld", or "spans <a>|<b>". */
  why: string;
}

export interface SpoolEnvelope {
  spool: string;
  page: number;
  /** Extent along each plant axis, in mm. */
  upDownMm: number;
  nsMm: number;
  ewMm: number;
  /** What went into each total, so the total can be argued with. */
  parts: Record<PlantAxis, EnvelopePart[]>;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Two spans within this of each other on the axis count as nested. */
const CONTAIN_SLACK_PT = 2;
/** Ends this close are the same end -- what marks a TAIL rather than a part. */
const SHARED_END_PT = 4;

/** Where a dimension starts and ends, projected onto its own axis. */
function spanOf(d: { from: Pt; to: Pt }): readonly [number, number] {
  const dx = d.to.x - d.from.x;
  const dy = d.to.y - d.from.y;
  const len = Math.hypot(dx, dy) || 1;
  const u = { x: dx / len, y: dy / len };
  const t0 = d.from.x * u.x + d.from.y * u.y;
  const t1 = d.to.x * u.x + d.to.y * u.y;
  return [Math.min(t0, t1), Math.max(t0, t1)] as const;
}

/**
 * Drop any dimension whose span is CONTAINED in a longer one on the same axis.
 *
 * A sheet gives both the whole and its parts -- sheet 4 carries a 15109mm
 * overall with a 6000mm inside it -- and adding them all counts the same pipe
 * twice. Containment is decided by projecting onto the axis, so the outboard
 * offset an overall dimension is drawn at does not matter.
 */
export function outermost<T extends { mm: number; from: Pt; to: Pt }>(list: T[]): T[] {
  return list.filter((a) => {
    const [a0, a1] = spanOf(a);
    return !list.some((b) => {
      if (b === a || b.mm <= a.mm) return false;
      const [b0, b1] = spanOf(b);
      return b0 <= a0 + CONTAIN_SLACK_PT && a1 <= b1 + CONTAIN_SLACK_PT;
    });
  });
}

/**
 * Which spool does this length belong to?
 *
 * Both ends of the attachment are matched to a weld, and they have to AGREE.
 * Where they do not, the length crosses a spool boundary and belongs wholly
 * to neither -- with one exception worth stating, because it is the common
 * case on a forced cut: if the two welds are CONSECUTIVE they sit either
 * side of the cut itself, and the pipe between them is the first piece of
 * the later spool (a field weld closes the spool it ends). Sheet 4's 6000mm
 * piece between its two FW ticks is exactly that.
 *
 * Nothing here guesses. A length that reaches no weld, spans a bolted joint,
 * or crosses more than one boundary is returned as unplaced and shown as
 * such, rather than being pushed into whichever spool happens to be nearest.
 */
export function placeDimension(
  d: DimensionInput,
  welds: WeldInput[],
  spoolOf: (weldNo: number) => string | undefined
): { spool: string; weldNo: number } | { why: string } {
  if (!d.attach) return { why: "no pipe" };
  if (d.attach.coverage < MIN_PIPE_COVERAGE) return { why: "no pipe" };
  const nearest = (p: Pt) => {
    let best: { w: WeldInput; d: number } | null = null;
    for (const w of welds) {
      const gap = dist(w.mark, p);
      if (gap <= NEAR_WELD_PT && (!best || gap < best.d)) best = { w, d: gap };
    }
    return best;
  };
  const a = nearest(d.attach.from);
  const b = nearest(d.attach.to);
  // One end on a weld and the other on nothing is the ordinary case at the
  // end of a run. Take it, but only on a firm match -- see SOLE_WELD_PT.
  if (!a || !b) {
    const sole = a ?? b;
    if (!sole || sole.d > SOLE_WELD_PT) return { why: "no weld" };
    const s = spoolOf(sole.w.weldNo);
    return s ? { spool: s, weldNo: sole.w.weldNo } : { why: "no weld" };
  }
  const sa = spoolOf(a.w.weldNo);
  const sb = spoolOf(b.w.weldNo);
  if (!sa || !sb) return { why: "no weld" };
  if (sa === sb) return { spool: sa, weldNo: a.w.weldNo };
  if (Math.abs(a.w.weldNo - b.w.weldNo) === 1) {
    const hi = a.w.weldNo > b.w.weldNo ? a.w : b.w;
    const s = spoolOf(hi.weldNo);
    if (s) return { spool: s, weldNo: hi.weldNo };
  }
  return { why: `spans ${sa}|${sb}` };
}

/**
 * Subtract an overshoot the sheet prints as its own dimension.
 *
 * A length that runs past the weld ending its spool measures pipe the next
 * spool owns, and the draughtsman usually dimensions that tail separately --
 * sheet 1's 1186 runs from the elbow past the field weld, and the 305 beside
 * it, labelled FW, is exactly the part beyond. Adding both counts the tail
 * once and the whole run once; dropping the tail as "contained" leaves the
 * length overstated. The spool's share is the DIFFERENCE.
 *
 * The tail is recognised by sharing an END with the length it belongs to and
 * lying inside it -- on the reference ISO both attach at (781.8,498). That
 * is what tells it apart from an OVERALL dimension containing its parts,
 * where the parts sit in the middle and `outermost` is right to drop them.
 * Only a length actually flagged as overshooting is treated this way.
 */
function subtractOvershoots<T extends { mm: number; from: Pt; to: Pt; overshootPt?: number; printedMm?: number; correctionWhy?: string }>(
  list: T[]
): T[] {
  const tails = new Set<T>();
  const out = list.map((h) => {
    if (h.overshootPt == null) return h;
    const [h0, h1] = spanOf(h);
    for (const q of list) {
      if (q === h || q.mm >= h.mm || tails.has(q)) continue;
      const [q0, q1] = spanOf(q);
      if (q0 < h0 - CONTAIN_SLACK_PT || q1 > h1 + CONTAIN_SLACK_PT) continue; // not inside
      const sharesEnd = Math.abs(q0 - h0) <= SHARED_END_PT || Math.abs(q1 - h1) <= SHARED_END_PT;
      if (!sharesEnd) continue;
      tails.add(q);
      return {
        ...h,
        mm: h.mm - q.mm,
        printedMm: h.printedMm ?? h.mm,
        correctionWhy: `runs past the weld that ends this spool; the sheet prints the ${q.mm}mm beyond it separately`,
        overshootPt: undefined,
      };
    }
    return h;
  });
  return out.filter((x) => !tails.has(x as T));
}

export function buildSpoolEnvelopes(
  dimensions: DimensionInput[],
  welds: WeldInput[],
  assignment: SpoolAssignmentInput[],
  frame?: IsoFrame
): { envelopes: SpoolEnvelope[]; unplaced: UnplacedLength[] } {
  const spoolKey = new Map(assignment.map((a) => [`${a.page}:${a.weldNo}`, a.spool]));
  const byPage = new Map<number, WeldInput[]>();
  for (const w of welds) byPage.set(w.page, [...(byPage.get(w.page) ?? []), w]);

  type Held = {
    cell: string;
    mm: number;
    from: Pt;
    to: Pt;
    drawnAs: PlantDirection;
    weldNo: number;
    printedMm?: number;
    correctionWhy?: string;
    overshootPt?: number;
    overshootWeldNo?: number;
  };
  const acc = new Map<string, { page: number; axes: Map<PlantAxis, Held[]> }>();
  const unplaced: UnplacedLength[] = [];

  for (const d of dimensions) {
    if (d.mm == null || d.mm <= 0) continue;
    const axis = plantAxis(d.degrees, frame);
    if (!axis) continue;
    const drawnAs = plantDirection(pageAngleOf(d.from, d.to), frame);
    if (!drawnAs) continue;
    const placed = placeDimension(d, byPage.get(d.page) ?? [], (no) => spoolKey.get(`${d.page}:${no}`));
    if ("why" in placed) {
      unplaced.push({ cell: d.cell, page: d.page, mm: d.mm, why: placed.why });
      continue;
    }
    const e = acc.get(placed.spool) ?? { page: d.page, axes: new Map<PlantAxis, Held[]>() };
    e.axes.set(axis, [
      ...(e.axes.get(axis) ?? []),
      {
        cell: d.cell,
        mm: d.mm,
        // The ATTACH points, not the drawn line. Containment between two
        // lengths has to be judged on the PIPE: a dimension is drawn at
        // whatever offset suits the sheet, and two at different offsets
        // project onto the axis at different places even when one brackets
        // the other. Sheet 1's 305 sits inside the 1186 on the run and
        // outside it on paper.
        from: d.attach?.from ?? d.from,
        to: d.attach?.to ?? d.to,
        drawnAs,
        weldNo: placed.weldNo,
        ...(d.printedMm != null && d.printedMm !== d.mm
          ? { printedMm: d.printedMm, correctionWhy: d.correctionWhy ?? "corrected" }
          : {}),
        ...(() => {
          // Only worth saying where it has NOT already been corrected for.
          if (d.printedMm != null && d.printedMm !== d.mm) return {};
          const over = d.attach ? overshootPt(d.attach, placed.spool, byPage.get(d.page) ?? [], (n) => spoolKey.get(`${d.page}:${n}`)) : null;
          return over ? { overshootPt: over.pt, overshootWeldNo: over.weldNo } : {};
        })(),
      },
    ]);
    acc.set(placed.spool, e);
  }

  const envelopes = [...acc.entries()]
    .map(([spool, e]) => {
      const kept = (a: PlantAxis) => outermost(subtractOvershoots(e.axes.get(a) ?? []));
      const total = (a: PlantAxis) => kept(a).reduce((n, x) => n + x.mm, 0);
      const listed = (a: PlantAxis): EnvelopePart[] =>
        kept(a).map((x) => ({
          cell: x.cell,
          mm: x.mm,
          drawnAs: x.drawnAs,
          weldNo: x.weldNo,
          ...(x.printedMm != null ? { printedMm: x.printedMm, correctionWhy: x.correctionWhy } : {}),
          ...(x.overshootPt != null ? { overshootPt: x.overshootPt, overshootWeldNo: x.overshootWeldNo } : {}),
        }));
      return {
        spool,
        page: e.page,
        upDownMm: total("UP-DOWN"),
        nsMm: total("N-S"),
        ewMm: total("E-W"),
        parts: { "UP-DOWN": listed("UP-DOWN"), "N-S": listed("N-S"), "E-W": listed("E-W") },
      };
    })
    .sort((a, b) => a.spool.localeCompare(b.spool));

  return { envelopes, unplaced };
}
