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
import { chainLegs, shapeExtent, type SpoolShape } from "./spoolShape";

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
  /** The weld's bore, from the WELD LIST. Geometry cannot supply it, and it is
   *  what tells a REDUCER from a valve where neither has pipe under it. */
  size?: string;
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
  /** Every weld this length reaches -- one at each end. The field weld's
   *  150mm of slack goes on the axis of the length that TOUCHES it, and a
   *  length ending at its spool's closing weld reaches two. */
  weldNos?: number[];
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
  /**
   * The run's real shape, where its legs chained into one. Absent where they
   * did not -- a branch forks the walk -- and the three extents above are
   * then all there is.
   */
  shape?: SpoolShape;
}

/**
 * How far a spool reaches along ONE axis, given its legs on that axis.
 *
 * NOT the sum. A leg has a direction, and a run that goes 754 EAST and then
 * 2795 WEST does not reach 3549 -- it doubles back over ground it has already
 * covered. Summing them inflated N-16's E-W to 3549mm, which fits no
 * container at all, and N-03's height to 3652 where the drawing gives DOWN
 * 2882 and UP 770.
 *
 * **The extent is max(sum of one direction, sum of the other), and that bound
 * is exact without knowing the order the legs come in.** The proof is short
 * enough to keep: walking the run gives a position after each leg, and the
 * extent is the highest position reached minus the lowest. To get from the
 * highest to the lowest you travel only in the negative direction, so that
 * drop is at most the sum of the negative legs; if the lowest comes first,
 * the same argument in reverse bounds it by the sum of the positive legs. So
 * the extent never exceeds the larger of the two sums -- and it is REACHED,
 * by the order that takes every positive leg before every negative one.
 *
 * So this is the tight upper bound over every order the legs could run in,
 * which is the right thing for a shipping figure: the run's topology is not
 * solved, and an over-estimate picks a bigger container while an
 * under-estimate strands a spool on a dock.
 *
 * It can still over-state a real run -- legs that alternate cancel further
 * than the grouped order does -- so it is a bound, not a measurement. The
 * page lists the legs under it so the bound can be argued with.
 */
export function axisExtent(parts: Array<{ mm: number; drawnAs: PlantDirection }>): number {
  const by = new Map<PlantDirection, number>();
  for (const p of parts) by.set(p.drawnAs, (by.get(p.drawnAs) ?? 0) + p.mm);
  return Math.max(0, ...by.values());
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Two spans within this of each other on the axis count as nested. */
const CONTAIN_SLACK_PT = 2;
/** Ends this close are the same end -- what marks a TAIL rather than a part. */
const SHARED_END_PT = 4;
/** How far inside the span a weld must sit to count as bracketed BY it rather
 *  than as the end the dimension stops at. */
const INSIDE_MARGIN_PT = 8;
/**
 * How near a weld must be to a span to speak for the bore there.
 *
 * A reducer sits AT the length dimensioned across it. Sheet 2's 89mm has its
 * pair 3 and 36pt away; sheet 1's 108mm, which must stay out, has its nearest
 * weld 107pt off and the next 135 -- welds further up the run entirely, whose
 * differing bores would otherwise fake a size change.
 */
const REDUCER_WELD_PT = 60;
/**
 * How near two spans must be, ACROSS their direction, to be the same piece of
 * pipe. Judged on the attach, so a whole and its part land on one line and
 * differ only by rounding; separate legs are far apart (N-03's two vertical
 * drops attach 225pt apart). Deliberately tight -- being generous here is what
 * makes one leg swallow another.
 */
const SAME_LINE_PT = 10;
/** How near a run segment must be to name the leg a dimension brackets. */
const RUN_DIRECTION_PT = 60;

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
      // SAME AXIS IS NOT THE SAME PIPE. A span is projected onto its own
      // direction, so two legs running parallel at different places on the
      // sheet collapse onto the same interval and one looks nested inside the
      // other. Sheet 1's N-03 has a 2376mm drop at one end and a separate
      // 506mm drop at the other, both vertical: the 506 vanished into the 2376
      // and 506mm of spool went missing. A part can only be contained in a
      // whole they are BOTH ON.
      if (!collinear(a, b)) return false;
      const [b0, b1] = spanOf(b);
      return b0 <= a0 + CONTAIN_SLACK_PT && a1 <= b1 + CONTAIN_SLACK_PT;
    });
  });
}

/** Do these two spans lie on one line, rather than merely run parallel? */
function collinear(a: { from: Pt; to: Pt }, b: { from: Pt; to: Pt }): boolean {
  const len = dist(a.from, a.to);
  if (len < 1) return false;
  const n = { x: -(a.to.y - a.from.y) / len, y: (a.to.x - a.from.x) / len };
  const off = (p: Pt) => Math.abs((p.x - a.from.x) * n.x + (p.y - a.from.y) * n.y);
  return off(b.from) <= SAME_LINE_PT && off(b.to) <= SAME_LINE_PT;
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
/** How far along a span a point lies, measured from its `from` end. */
function alongSpan(span: { from: Pt; to: Pt }, p: Pt): number {
  const len = dist(span.from, span.to) || 1;
  return ((p.x - span.from.x) * (span.to.x - span.from.x) + (p.y - span.from.y) * (span.to.y - span.from.y)) / len;
}

/** How far off a span's LINE a point lies. */
function offSpan(span: { from: Pt; to: Pt }, p: Pt): number {
  const len = dist(span.from, span.to) || 1;
  return Math.abs(((p.x - span.from.x) * -(span.to.y - span.from.y) + (p.y - span.from.y) * (span.to.x - span.from.x)) / len);
}

/** Distance from a point to the span itself, ends included. */
function segmentGap(span: { from: Pt; to: Pt }, p: Pt): number {
  const len = dist(span.from, span.to);
  if (len < 1e-6) return dist(p, span.from);
  const t = Math.max(0, Math.min(1, alongSpan(span, p) / len));
  return dist(p, { x: span.from.x + t * (span.to.x - span.from.x), y: span.from.y + t * (span.to.y - span.from.y) });
}

/** The welds sitting strictly between a dimension's two ends, along its span. */
function weldsInside(attach: { from: Pt; to: Pt }, welds: WeldInput[]): WeldInput[] {
  const len = dist(attach.from, attach.to);
  if (len < 1) return [];
  const dir = { x: (attach.to.x - attach.from.x) / len, y: (attach.to.y - attach.from.y) / len };
  return welds.filter((w) => {
    const along = (w.mark.x - attach.from.x) * dir.x + (w.mark.y - attach.from.y) * dir.y;
    if (along <= INSIDE_MARGIN_PT || along >= len - INSIDE_MARGIN_PT) return false;
    // ON the span, not merely projecting onto it -- another leg running
    // parallel some distance away must not be counted as inside this one.
    const off = Math.abs((w.mark.x - attach.from.x) * -dir.y + (w.mark.y - attach.from.y) * dir.x);
    return off <= ON_LINE_PT;
  });
}

export function placeDimension(
  d: DimensionInput,
  welds: WeldInput[],
  spoolOf: (weldNo: number) => string | undefined
): { spool: string; weldNo: number; weldNos: number[] } | { why: string } {
  if (!d.attach) return { why: "no pipe" };
  const attach = d.attach;
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

  // NO PIPE UNDER THE SPAN: a bolted-in valve, or a welded fitting?
  //
  // A valve sits between two flanges and ships on its own, so a length across
  // one is no part of any spool -- that is what the coverage test is for, and
  // the eight 464mm valve assemblies it rejects are all correct. But a
  // REDUCING TEE or a reducer interrupts the drawn line just as completely and
  // is a FABRICATION item: welded in, shipped with the spool. Coverage cannot
  // tell them apart -- both read 0%.
  //
  // The BORE does. A reducer is where the line changes size, so its two
  // flanking welds differ; a valve's do not. Sheet 2 has both, 30pt apart: its
  // 241mm spans welds 14 and 15 at 200 and 150 (the reducing tee, and N-06 is
  // 894 not 653 without it), while its 273mm spans welds 15 and 16 at 150 and
  // 150 -- the gate valve in the reduced section, correctly dropped.
  // Judged on the welds ALONG THE SPAN'S OWN LINE, not on the two its ends
  // happened to match. A short piece across a reducer can have BOTH ends
  // nearest the same weld -- sheet 2's 89mm measures 14.6pt on the page, and
  // both its ends resolve to weld 16 -- while the size change is between weld
  // 16 at 150 and weld 17 at 200, the pair straddling it.
  const nearLine = welds
    .map((w) => ({ w, along: alongSpan(attach, w.mark), off: offSpan(attach, w.mark) }))
    .filter((x) => x.off <= ON_LINE_PT && segmentGap(attach, x.w.mark) <= REDUCER_WELD_PT && String(x.w.size ?? "").trim())
    .sort((x, y) => segmentGap(attach, x.w.mark) - segmentGap(attach, y.w.mark))
    .slice(0, 2);
  const acrossReducer = nearLine.length === 2 && String(nearLine[0].w.size).trim() !== String(nearLine[1].w.size).trim();
  if (attach.coverage < MIN_PIPE_COVERAGE && !acrossReducer) return { why: "no pipe" };
  // One end on a weld and the other on nothing is the ordinary case at the
  // end of a run. Take it, but only on a firm match -- see SOLE_WELD_PT.
  if (!a || !b) {
    const sole = a ?? b;
    if (!sole || sole.d > SOLE_WELD_PT) return { why: "no weld" };
    const s = spoolOf(sole.w.weldNo);
    return s ? { spool: s, weldNo: sole.w.weldNo, weldNos: [sole.w.weldNo] } : { why: "no weld" };
  }
  const sa = spoolOf(a.w.weldNo);
  const sb = spoolOf(b.w.weldNo);
  if (!sa || !sb) return { why: "no weld" };
  // BOTH welds, not just the near one. A length ending AT a spool's closing
  // weld reports only the weld at its other end otherwise, and the container
  // check then cannot see that it touches the field weld -- N-02's 881 named
  // weld 11 while the field weld it runs to is 12, so the 150mm of excess got
  // put on the longest side (3437 east) instead of the N-S leg it belongs on.
  if (sa === sb) return { spool: sa, weldNo: a.w.weldNo, weldNos: [...new Set([a.w.weldNo, b.w.weldNo])] };

  // THE ENDS DISAGREE. That does not always mean the length crosses a spool.
  //
  // A dimension ends at the FITTING -- the elbow's corner, the flange face --
  // not at the weld dot a few points inside it, so an end can match the last
  // weld of the spool BEFORE the one whose pipe it actually brackets. Sheet 1's
  // 2376mm drop is the case: it runs from the elbow at the top of the leg down
  // to weld 14, its upper end lands 27pt from weld 12 (the field weld closing
  // N-02, sitting on the horizontal leg above the corner) and 41pt from weld
  // 13, so the ends read N-02 and N-03 and 2376mm of N-03 went unreported.
  //
  // What a dimension measures is the pipe BETWEEN its ends, so the welds INSIDE
  // the span are what say whose that is. Where they all belong to one spool,
  // that is the answer whatever the ends brush against.
  // Every weld the span actually brackets -- NOT excluding the two the ends
  // matched. Excluding them threw away the evidence that matters: sheet 3's
  // 6761mm overall reaches 26pt past weld 7, which is N-11's, and dropping
  // weld 7 because an end also matched it left only N-10's welds inside and
  // handed a genuinely cross-spool length to N-10. `weldsInside` already keeps
  // out the welds sitting AT the ends, by INSIDE_MARGIN_PT.
  const inside = weldsInside(d.attach, welds);
  const insideSpools = [...new Set(inside.map((w) => spoolOf(w.weldNo)).filter((x): x is string => Boolean(x)))];
  if (insideSpools.length === 1) {
    const spool = insideSpools[0];
    const candidates = [...inside, a.w, b.w].filter((w) => spoolOf(w.weldNo) === spool).map((w) => w.weldNo);
    return { spool, weldNo: Math.max(...candidates), weldNos: [...new Set(candidates)] };
  }

  // Nothing inside to go on: two welds either side of the cut itself, with the
  // pipe between them the first piece of the later spool -- a field weld closes
  // the spool it ends. Sheet 4's 6000mm piece between its two FW ticks.
  if (Math.abs(a.w.weldNo - b.w.weldNo) === 1) {
    const hi = a.w.weldNo > b.w.weldNo ? a.w : b.w;
    const s = spoolOf(hi.weldNo);
    if (s) return { spool: s, weldNo: hi.weldNo, weldNos: [...new Set([a.w.weldNo, b.w.weldNo])] };
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

/**
 * WHICH WAY A LEG RUNS: the order CAD wrote the dimension's endpoints.
 *
 * That sounds like noise and it was assumed to be. It is not, on this
 * exporter. An attempt to override it with the direction of the pipe
 * underneath -- orienting the run graph outward from the end a flow arrow
 * points away from -- was measured against it across both drawings: 48 legs
 * agreed, 24 differed, and the differences were not scattered. They came in
 * whole components: EVERY horizontal on page 2, every one on page 5, the two
 * branch legs on page 1. That is the signature of a fragment rooted backwards,
 * not of a bad endpoint order -- the run graph is built from the heaviest line
 * weight, which leaves a sheet in several disconnected pieces, and a piece
 * holding no flow arrow has nothing to root it but a guess at which end comes
 * first.
 *
 * Where it could be checked the drawn order won: page 1's two weldolet
 * branches rise 385 each, which the drawn order gives and the guess reversed,
 * and page 2's run goes EAST, which the drawn order gives and the guess
 * reversed. So the drawn order stands, and the flow arrow is used for what it
 * is reliably good for -- orienting the weld walk in isoRunOrder.
 *
 * Do not re-attempt the override without first fixing component rooting; the
 * comparison above is the test it has to pass.
 */
/** A piece of the run, pointed the way the pipe TRAVELS. */
export interface RunSegmentInput {
  page: number;
  from: Pt;
  to: Pt;
}

/**
 * Which way the pipe runs where a dimension attaches to it.
 *
 * Supplied ONLY for the fragments a flow arrow actually orients (see
 * isoRunOrder): an arrow-less fragment has nothing to root it but a guess, and
 * guessing was measured to reverse whole components. Where a segment is
 * present it is the drawing SAYING which way the fluid goes, and it beats the
 * endpoint order CAD happened to write; where none is, the drawn order stands.
 */
function directionFromRun(
  attach: { from: Pt; to: Pt },
  axis: PlantAxis,
  segments: RunSegmentInput[],
  frame?: IsoFrame
): PlantDirection | null {
  const mid = { x: (attach.from.x + attach.to.x) / 2, y: (attach.from.y + attach.to.y) / 2 };
  let best: { d: number; dir: PlantDirection } | undefined;
  for (const sg of segments) {
    const dir = plantDirection(pageAngleOf(sg.from, sg.to), frame);
    // Only a segment on the dimension's OWN axis can name it: a dimension is
    // drawn parallel to what it measures, so anything else is another leg.
    if (!dir || plantAxis(pageAngleOf(sg.from, sg.to), frame) !== axis) continue;
    const d = segmentGap({ from: sg.from, to: sg.to }, mid);
    if (!best || d < best.d) best = { d, dir };
  }
  return best && best.d <= RUN_DIRECTION_PT ? best.dir : null;
}

export function buildSpoolEnvelopes(
  dimensions: DimensionInput[],
  welds: WeldInput[],
  assignment: SpoolAssignmentInput[],
  frame?: IsoFrame,
  /** The run where a flow arrow orients it. Names a leg UP or DOWN; absent,
   *  the drawn endpoint order stands. */
  runSegments: RunSegmentInput[] = []
): { envelopes: SpoolEnvelope[]; unplaced: UnplacedLength[] } {
  const runByPage = new Map<number, RunSegmentInput[]>();
  for (const sg of runSegments) runByPage.set(sg.page, [...(runByPage.get(sg.page) ?? []), sg]);
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
    weldNos: number[];
    printedMm?: number;
    correctionWhy?: string;
    overshootPt?: number;
    overshootWeldNo?: number;
  };
  const acc = new Map<string, { page: number; axes: Map<PlantAxis, Held[]> }>();
  const unplaced: UnplacedLength[] = [];

  // A LENGTH THAT CROSSES A BOUNDARY, WHERE THE SHEET PRINTS THE PART BEYOND
  // IT SEPARATELY, STILL HAS A SHARE.
  //
  // `subtractOvershoots` already handles this where the length lands inside one
  // spool and merely runs past its closing weld (sheet 1's 1186 less its 305).
  // The same thing happens with the length reaching properly into the NEXT
  // spool, and then both ends name different spools and the whole thing is
  // refused: sheet 3's 6761 runs from inside N-10 up to the apex in N-11, the
  // sheet prints that last stretch as its own 761, and 6000mm of N-10 -- the
  // forced-cut length, on the sheet whose cut IS a field weld -- went
  // unreported.
  //
  // The tail is recognised exactly as it is there: a shorter length on the SAME
  // LINE, lying inside this one and SHARING AN END with it. What remains is the
  // near part, and it is placed on its own ends like any other length.
  /** The page's spools in run order, which is the order of their weld blocks. */
  const spoolOrder = (page: number) => {
    const lowest = new Map<string, number>();
    for (const a of assignment) {
      if (a.page !== page) continue;
      const at = lowest.get(a.spool);
      if (at == null || a.weldNo < at) lowest.set(a.spool, a.weldNo);
    }
    return [...lowest.entries()].sort((x, y) => x[1] - y[1]).map(([s]) => s);
  };

  const trimmed = dimensions.map((d) => {
    if (d.mm == null || d.mm <= 0 || !d.attach) return d;
    const here = byPage.get(d.page) ?? [];
    if (!("why" in placeDimension(d, here, (no) => spoolKey.get(`${d.page}:${no}`)))) return d;
    const span = d.attach;
    for (const t of dimensions) {
      if (t === d || t.page !== d.page || t.mm == null || t.mm <= 0 || !t.attach || t.mm >= d.mm) continue;
      if (!collinear(span, t.attach)) continue;
      const ends: Array<[Pt, Pt]> = [
        [span.from, span.to],
        [span.to, span.from],
      ];
      for (const [far, shared] of ends) {
        const tEnds = [t.attach.from, t.attach.to];
        const at = tEnds.findIndex((q) => dist(q, shared) <= SHARED_END_PT);
        if (at < 0) continue;
        const inner = tEnds[1 - at];
        // The tail must lie INSIDE, not stick out past the far end.
        if (dist(inner, far) > dist(shared, far)) continue;
        // AND WHAT REMAINS MUST BE ONE SPOOL'S. Removing a single printed tail
        // cannot resolve a length that crosses more than one boundary: sheet
        // 4's 15109 runs the whole sheet, N-12 through N-14, and trimming its
        // 3100 left 12009 that still spans all three -- which landed in N-12
        // and gave it a 12m extent it does not have.
        // THE TAIL AND WHAT REMAINS MUST BE NEIGHBOURS. Removing one printed
        // tail can only resolve a length that crosses ONE boundary. Sheet 4's
        // 15109 runs the whole sheet, N-12 through N-15; taking its 3100 off
        // left 12009 that still spans three spools, and it landed in N-12 as a
        // 12-metre extent. The 6761 is the real case: it crosses exactly one
        // boundary, N-10 to N-11, and its 761 tail is the N-11 side.
        const remainder = { from: far, to: inner, coverage: span.coverage };
        const rest = placeDimension({ ...d, attach: remainder }, here, (no) => spoolKey.get(`${d.page}:${no}`));
        const tail = placeDimension(t, here, (no) => spoolKey.get(`${t.page}:${no}`));
        if ("why" in rest || "why" in tail) continue;
        const order = spoolOrder(d.page);
        const gap = Math.abs(order.indexOf(rest.spool) - order.indexOf(tail.spool));
        if (rest.spool === tail.spool || gap !== 1) continue;
        return {
          ...d,
          mm: d.mm - t.mm,
          printedMm: d.mm,
          correctionWhy: `crosses the spool boundary; the sheet prints the ${t.mm}mm beyond it as ${t.cell}`,
          attach: remainder,
        };
      }
    }
    return d;
  });

  for (const d of trimmed) {
    if (d.mm == null || d.mm <= 0) continue;
    const axis = plantAxis(d.degrees, frame);
    if (!axis) continue;
    const attachSpan = d.attach ?? { from: d.from, to: d.to };
    const drawnAs =
      directionFromRun(attachSpan, axis, runByPage.get(d.page) ?? [], frame) ?? plantDirection(pageAngleOf(d.from, d.to), frame);
    if (!drawnAs) continue;
    const placed = placeDimension(d, byPage.get(d.page) ?? [], (no) => spoolKey.get(`${d.page}:${no}`));
    if ("why" in placed) {
      unplaced.push({ cell: d.cell, page: d.page, mm: d.mm, why: placed.why });
      continue;
    }
    // KEYED BY SHEET AS WELL AS SPOOL. A spool that carries onto the next
    // sheet gets one envelope per sheet rather than one summed over both:
    // N-15 runs from sheet 4 onto sheet 5, and summing gave it sheet 5's drop
    // and east legs on top of sheet 4's rise and north leg -- a box that is
    // not the shape of either piece. Each sheet's portion is a thing you can
    // look at and check; the sum of two sheets is not.
    const key = `${d.page}:${placed.spool}`;
    const e = acc.get(key) ?? { page: d.page, axes: new Map<PlantAxis, Held[]>() };
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
        weldNos: placed.weldNos,
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
    acc.set(key, e);
  }

  // NOTE: an earlier version here pushed a measured direction onto the legs
  // that had none, on the reasoning that a spool's legs run the same way. They
  // do not. N-03 drops 2376 down its main leg and RISES 385 up each of two
  // weldolet branches, so carrying the main run's DOWN onto them reported a
  // spool that only ever descends. A leg with no pipe under it keeps the drawn
  // fallback and is left to be argued with.

  const envelopes = [...acc.entries()]
    .map(([key, e]) => {
      const spool = key.slice(key.indexOf(":") + 1);
      const kept = (a: PlantAxis) => outermost(subtractOvershoots(e.axes.get(a) ?? []));
      const total = (a: PlantAxis) => axisExtent(kept(a));
      const listed = (a: PlantAxis): EnvelopePart[] =>
        kept(a).map((x) => ({
          cell: x.cell,
          mm: x.mm,
          drawnAs: x.drawnAs,
          weldNo: x.weldNo,
          weldNos: x.weldNos,
          ...(x.printedMm != null ? { printedMm: x.printedMm, correctionWhy: x.correctionWhy } : {}),
          ...(x.overshootPt != null ? { overshootPt: x.overshootPt, overshootWeldNo: x.overshootWeldNo } : {}),
        }));
      // THE RUN, where the legs chain into one. The attach segments join end
      // to end, so the order comes out of the geometry with no weld graph --
      // and with the order, the spool stops being a box and becomes the shape
      // it really is. A branch forks the walk and `chainLegs` refuses; those
      // spools keep the box, which is what they had before.
      const allLegs = (["UP-DOWN", "N-S", "E-W"] as PlantAxis[]).flatMap((a) =>
        kept(a).map((x) => ({ cell: x.cell, mm: x.mm, direction: x.drawnAs, from: x.from, to: x.to }))
      );
      const shape = chainLegs(allLegs);
      const extent = shape ? shapeExtent(shape) : null;
      return {
        spool,
        page: e.page,
        // Where the run is known the extent is MEASURED; otherwise it is
        // `axisExtent`'s tight-but-unordered bound. They agree wherever a run
        // never doubles back, which is most of them.
        upDownMm: extent ? extent.upDownMm : total("UP-DOWN"),
        nsMm: extent ? extent.nsMm : total("N-S"),
        ewMm: extent ? extent.ewMm : total("E-W"),
        parts: { "UP-DOWN": listed("UP-DOWN"), "N-S": listed("N-S"), "E-W": listed("E-W") },
        ...(shape ? { shape } : {}),
      };
    })
    .sort((a, b) => a.spool.localeCompare(b.spool));

  return { envelopes, unplaced };
}
