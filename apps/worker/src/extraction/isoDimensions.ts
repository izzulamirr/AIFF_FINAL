// Finds the DIMENSIONS printed on an isometric, and what each one measures.
//
// Needed because an isometric is NOT drawn to scale -- measured on the
// reference ISO, one run gives 202mm over 77pt and another 464mm over 98pt, so
// page distance says nothing about real length. The numbers have to be read.
//
// But only the NUMBER has to be read. Everything else about a dimension is
// geometry: it is a line with an ARROWHEAD AT EACH END, drawn parallel to the
// thing it measures and offset from it, and its two arrowheads sit exactly at
// the extent being dimensioned. So the span, the direction and the axis all
// come out of the drawing for free, and the only thing left for a model is a
// short numeric label at a known box -- the same shape of problem as the weld
// number flags, and solvable the same cheap way.
//
// A dimension comes in two drawn shapes, and BOTH have to be looked for:
//
//     one line              split by its text
//                                  |
//                                  v
//     |<--- 464 --->|             184
//                                  ^
//                                  |
//
// In the split form the line is broken to make room for the number, so each
// half carries an arrowhead at only its OUTER end. Looking only for a head at
// both ends of one segment misses these entirely -- which is how the 184 on
// sheet 1's branch went missing while its 404 neighbour was found.
import { readPageGeometry, type GeomPath } from "../pdfGeometry";
import type { Pt } from "./isoWeldMarks";

export interface IsoDimension {
  /** The two ends of the dimension line: the extent being measured. */
  from: Pt;
  to: Pt;
  /** Page length in points -- for sanity only, never for a real length. */
  pagePt: number;
  /** Page angle, 0-180. On an isometric this is ~30, ~90 or ~150. */
  degrees: number;
  /** Box around the printed number, for cropping it to be read. */
  labelBox: { x0: number; y0: number; x1: number; y1: number } | null;
  /** How it was drawn: one line, or two halves with the number between them. */
  drawnAs: "line" | "split";
  /**
   * Whether this dimension measures something ON THE DRAWING -- both ends
   * carry a witness line, and the two run parallel, which is what makes the
   * drawn length equal the measured length. A dimension without that pair is
   * not bracketing a piece of pipe.
   */
  measuresPipe: boolean;
  /** Page angle of the witness lines, when there is a matched pair. */
  witnessDegrees: number | null;
  /**
   * The two points ON THE PIPE that this dimension brackets, and how much
   * pipe runs between them. Null where the witness direction is unknown.
   *
   * This is what ties a printed length to a piece of the drawing, and so to
   * a spool. Sliding the dimension back onto the run is only possible
   * because both ends are offset by the SAME amount (see `pipeAttachment`).
   */
  attach: PipeAttachment | null;
}

/** Where a dimension meets the pipe it measures. */
export interface PipeAttachment {
  from: Pt;
  to: Pt;
  /** Fraction of the span with pipe drawn under it, 0..1. */
  coverage: number;
}

const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** An arrowhead is a small filled triangle. */
const HEAD_MIN_PT = 3;
const HEAD_MAX_PT = 12;
/**
 * How close an arrowhead must sit to the line's end to belong to it, measured
 * to whichever of its APEX or CENTRE is nearer.
 *
 * Swept on both revisions with that apex-aware match: 6 gives 89/90 and still
 * misses sheet 2's 920, 7 gives 92/92 and finds it, 8 gives 90/90 and 9 drops
 * to 87/87 as heads start pairing with ends they do not belong to. 7 is the
 * peak, and it is the same on both drawings.
 */
const HEAD_TOLERANCE_PT = 7;
/**
 * An arrowhead POINTS ALONG the line it terminates. Without this a weld dot
 * passes as an arrowhead -- it is a small filled blob of much the same size --
 * and then any pipe with a weld at each end reads as a dimension.
 */
const HEAD_ALIGN_COS = 0.85;
/**
 * Shorter than this and it is a leader tick, not a dimension worth reading.
 *
 * MEASURED. 20 was costing a real length: sheet 2's 89mm piece across the
 * 200x150 reducer just before weld 16 measures 14.6pt apex to apex -- the
 * arrows are drawn OUTSIDE, as CAD does when the extent is too small to fit
 * them within -- so it was thrown away before anything could read it, and N-07
 * came out 751 where the drawing says 840.
 *
 * Swept on both revisions: 20, 16 and 14 all give the same count but 14 admits
 * that 89; 12 admits one more, a 12.1pt span on page 1 with no pipe under it;
 * below 10 nothing further appears. 14 is the value that takes the length the
 * drawing prints and nothing else.
 */
const MIN_DIMENSION_PT = 14;
/**
 * How far the apex-to-apex line may drift from the DRAWN line before the
 * arrowheads are assumed to have been mismatched. A dimension's two heads
 * and its line are one straight thing; anything else is two heads that do
 * not belong together.
 */
const APEX_DRIFT_DEG = 4;
/**
 * A dimension is annotation, and annotation is drawn light. The pipe itself is
 * the heaviest thing on an isometric (1.98 against 0.72 here), which is the
 * cheapest way to keep the run out of the dimension set entirely.
 */
const MAX_ANNOTATION_LW = 1.5;
/** The pipe is the heavy line; the same weight that keeps it out of the
 *  dimension set is what identifies it here. */
const PIPE_MIN_LW = 1.5;
/** A pipe run drawn slightly off its nominal axis is still that run. */
const PIPE_PARALLEL_DEG = 6;
/**
 * How far a witness line may carry a dimension back to its pipe.
 *
 * MEASURED, not guessed, and the same on both revisions of the reference ISO.
 * The offsets actually used cluster hard at 42-43pt -- the first dimension
 * chain -- with further chains at 59, 71, 81 and 85, and then NOTHING until
 * 118. Every offset beyond that gap is a dimension being dragged across the
 * sheet onto a pipe it does not measure: sheet 1's 15mm branch dimensions slid
 * 131 and 141pt onto the 200mm main run, which is long, heavy and parallel to
 * them, and came back 86-95% "covered" by pipe belonging to another leg
 * entirely.
 *
 * 200 let all of that through. 100 sits in the measured gap.
 */
const MAX_WITNESS_REACH_PT = 100;
/** Offsets this close describe the same slide-back. */
const OFFSET_GROUP_PT = 4;
// How much coverage MEANS a dimension is measuring pipe is not decided here:
// this file reports the fraction, `MIN_PIPE_COVERAGE` in @easy/shared judges
// it. One copy of the rule, in the place that acts on it.
/**
 * How close a witness line must PASS BY a dimension's tip to belong to it.
 * Measured to the line, not to its ends: a witness is drawn to CROSS the
 * dimension there and overshoot by however much the draughtsman left, so its
 * endpoints sit a variable distance away -- 6pt at one end of the reference
 * ISO's first dimension and 9pt at the other, which an endpoint test splits
 * and a crossing test does not.
 */
const WITNESS_TOUCH_PT = 8;
/** Witness lines must be parallel to each other, within this. */
const WITNESS_PARALLEL_DEG = 3;
/** A witness line runs on a DIFFERENT axis from the dimension it serves. */
const WITNESS_OFF_AXIS_DEG = 10;
/** Shorter than this and it is a tick on the dimension, not a witness line. */
const MIN_WITNESS_PT = 10;
/** A filled shape this close to the line is part of it, not part of the text. */
const ON_LINE_PT = 0.8;
/** A dimension on an isometric runs along a drawn axis, like everything else. */
const AXIS_DEGREES = [30, 90, 150];
const AXIS_TOLERANCE = 4;
/**
 * How far from the midpoint to look for glyphs belonging to the number.
 *
 * This can afford to be generous, because it only sets the CANDIDATE POOL --
 * GLYPH_GAP_PT is what actually separates one printed number from its
 * neighbours, by growing a single contiguous run. Too tight a reach instead
 * truncates long numbers: a four-digit label rotated to run along a vertical
 * dimension is some 40pt tall, so a 30pt reach dropped its outer digits and
 * "2000" cropped to "20".
 */
const LABEL_REACH_PT = 60;
/**
 * A glyph is small and STROKED. The exporter outlines its text, so a digit
 * arrives as a little stroked outline -- never as a filled blob. Getting this
 * wrong is what made the first attempt find no labels at all: it looked only
 * at FILLED shapes, which on this drawing are the arrowheads and weld dots.
 *
 * Point count is NOT the test, and using it cost four labels. A digit can be
 * very few points -- on the reference ISO a "7" is 3 and a "4" is 4 -- so a
 * minimum of 6 made the whole of "474" invisible, and the finder settled on
 * the "WOL 200X80" callout beside it instead. What that minimum was really
 * trying to exclude is arrowheads, and those are excluded by being FILLED.
 */
const GLYPH_MAX_PT = 14;
const GLYPH_MIN_POINTS = 3;
/** Glyphs closer than this to each other belong to the same printed number. */
const GLYPH_GAP_PT = 7;
/**
 * How far off the text's own line a glyph may sit and still be part of it.
 *
 * A dimension's number is ROTATED TO READ ALONG ITS OWN DIMENSION LINE, so its
 * glyphs lie in a narrow band parallel to the dimension. Everything else
 * printed nearby -- a BOM string, a "WOL 200X" callout, the neighbouring
 * dimension's number -- sits at some other offset across that band. Distance
 * alone does not separate them: widening the search to catch the outer digits
 * of a long number also chained "WOL 200X" onto four labels. Direction does.
 */
const LABEL_BAND_PT = 8;
/**
 * How far ACROSS its own dimension line the number may sit -- the test that
 * says which printed text belongs to THIS dimension.
 *
 * LABEL_BAND_PT above holds a run together once it has started. This decides
 * where it STARTS, and the two are not the same job: the band is measured from
 * the seed, so a seed on the wrong text grows a tidy, confident box round the
 * wrong text. Seeding on whatever glyph is NEAREST THE MIDPOINT is what went
 * wrong, and it goes wrong in a specific place -- beside a FIELD WELD, where
 * the sheet prints an "FW" note and a hatched tick right against the pipe, and
 * beside a weld flag, whose label is as much a small stroked run as a digit is.
 *
 * A number belongs to a dimension by sitting ON ITS LINE: in the gap of a split
 * line, just clear of a continuous one, or -- where the extent is too small to
 * hold it -- further out along that same line, past the arrowheads. What it
 * never does is stand off to the side, because a number to the side of a line
 * is a number about something else.
 *
 * MEASURED, on every label box of both revisions of the reference ISO, as the
 * distance from the dimension's own line to the box centre:
 *
 *   revised   0 -- 8.6  (90 labels, all read correctly)   15.8, 20.6, 29.0
 *   original  0 -- 9.0  (89 labels, all read correctly)   13.9, 21.7, 29.0
 *
 * Nothing at all between 9.0 and 13.9, on either drawing, and the six outliers
 * are exactly the six cells that came back unreadable or wrong -- the "FW" note
 * that cost N-15 its 305, the two weld flags that read "BW4", and three with no
 * number printed near them at all. 11 sits in the measured gap.
 *
 * Where nothing is in the band there is NO LABEL, and that is reported rather
 * than papered over: a cell showing text that belongs to something else is
 * worse than no cell, because it invites a reading.
 */
const LABEL_ACROSS_PT = 11;
/** Breathing room so a digit is not shaved off at the edge of its crop. */
const LABEL_PAD_PT = 2.5;

/* --- the split form ------------------------------------------------------ */

/** Half of a split dimension: short, so it cannot meet MIN_DIMENSION_PT. */
const MIN_HALF_PT = 4;
/** Both halves lie on ONE line: how far off it the other half may sit. */
const COLLINEAR_OFFSET_PT = 1.5;
/**
 * The gap the number is printed in. A floor, because CAD also breaks a line
 * for reasons that are not text; a ceiling, because the two halves would
 * otherwise reach across a whole neighbouring dimension.
 */
const MIN_TEXT_GAP_PT = 4;
const MAX_TEXT_GAP_PT = 45;

const onAxis = (deg: number) => AXIS_DEGREES.some((a) => Math.abs(deg - a) <= AXIS_TOLERANCE);
/**
 * Names the EXTENT a pair of arrowheads spans, whichever way round the pair
 * was walked -- the same two heads get ordered oppositely depending on which
 * half's direction the projection used.
 */
const spanKey = (a: Pt, b: Pt) =>
  [`${a.x.toFixed(0)},${a.y.toFixed(0)}`, `${b.x.toFixed(0)},${b.y.toFixed(0)}`].sort().join("|");
const angleOf = (a: Pt, b: Pt) => ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 180;

/**
 * A collinear, outward-facing pair that was NOT taken, and why. Reported
 * rather than dropped: two real spool boundaries were once lost to a bare
 * `continue` in the cut finder, and the same silence would hide a dimension
 * the gap or label tests are wrong about.
 */
export interface SplitRejection {
  at: Pt;
  /** The two arrowheads the pair spans, for matching against what was taken. */
  ends: [Pt, Pt];
  spanPt: number;
  gapPt: number;
  why: "gap too small" | "gap too large" | "span too short" | "no number in the gap" | "heads face inward";
}

export interface DimensionRead {
  dimensions: IsoDimension[];
  splitRejections: SplitRejection[];
}

/**
 * The whole rule, over a page's paths and nothing else.
 *
 * Kept apart from the PDF so it can be tested against drawings this repo does
 * not have -- the reference ISO is one CAD exporter's habits, and a rule fitted
 * to it would look exactly like a rule that works.
 */
/**
 * Slide a dimension back onto the pipe it measures, and report how much pipe
 * it found there.
 *
 * A dimension is drawn PARALLEL to what it measures and offset from it, and
 * both ends are offset by the SAME amount along the witness direction --
 * that equal offset is exactly what makes the drawn length equal the
 * measured one. So one distance `t` slides the whole dimension onto its
 * subject, and the only question is which.
 *
 * Every pipe segment parallel to the dimension proposes an answer: there is
 * one `t` putting the dimension's line onto that segment's line. Take the
 * `t` with the most pipe under it.
 *
 * What this is really for is the COVERAGE, not the offset. A spool is what
 * is WELDED together; a valve is bolted in between two flanges and ships on
 * its own, so a dimension spanning one has no pipe beneath it at all and is
 * no part of any spool's size. That is a gap in the drawing, not a
 * judgement call -- see MIN_PIPE_COVERAGE.
 *
 * Exported so it can be tested against synthetic geometry rather than only
 * against the one drawing it was found on.
 */
export function pipeAttachment(
  from: Pt,
  to: Pt,
  witnessDegrees: number | null,
  pipes: Array<{ a: Pt; b: Pt }>
): PipeAttachment | null {
  if (witnessDegrees == null) return null;
  const len = dist(from, to);
  if (len < 1) return null;
  const dir = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
  const r = (witnessDegrees * Math.PI) / 180;
  const u = { x: Math.cos(r), y: Math.sin(r) };
  const parallelSin = Math.sin((PIPE_PARALLEL_DEG * Math.PI) / 180);

  // Each parallel pipe segment names the offset that would land on it.
  const offsets: Array<{ t: number; seg: { a: Pt; b: Pt } }> = [];
  for (const s of pipes) {
    const sl = dist(s.a, s.b);
    if (sl < 1) continue;
    const sd = { x: (s.b.x - s.a.x) / sl, y: (s.b.y - s.a.y) / sl };
    if (Math.abs(sd.x * dir.y - sd.y * dir.x) > parallelSin) continue;
    const den = u.x * sd.y - u.y * sd.x;
    if (Math.abs(den) < 1e-6) continue;
    const t = ((s.a.x - from.x) * sd.y - (s.a.y - from.y) * sd.x) / den;
    if (Math.abs(t) > MAX_WITNESS_REACH_PT) continue;
    offsets.push({ t, seg: s });
  }

  let best: { t: number; coverage: number } | null = null;
  for (const c of offsets) {
    const base = { x: from.x + c.t * u.x, y: from.y + c.t * u.y };
    // Every segment sharing this offset, projected onto the dimension.
    const spans: Array<[number, number]> = [];
    for (const g of offsets) {
      if (Math.abs(g.t - c.t) > OFFSET_GROUP_PT) continue;
      const p0 = (g.seg.a.x - base.x) * dir.x + (g.seg.a.y - base.y) * dir.y;
      const p1 = (g.seg.b.x - base.x) * dir.x + (g.seg.b.y - base.y) * dir.y;
      const lo = Math.max(0, Math.min(p0, p1));
      const hi = Math.min(len, Math.max(p0, p1));
      if (hi > lo) spans.push([lo, hi]);
    }
    // Union, not sum: a run redrawn over itself must not count twice.
    spans.sort((x, y) => x[0] - y[0]);
    let covered = 0;
    let end = 0;
    for (const [lo, hi] of spans) {
      const start = Math.max(lo, end);
      if (hi > start) {
        covered += hi - start;
        end = hi;
      }
    }
    const coverage = covered / len;
    if (!best || coverage > best.coverage) best = { t: c.t, coverage };
  }
  if (!best) return null;
  return {
    from: { x: Number((from.x + best.t * u.x).toFixed(1)), y: Number((from.y + best.t * u.y).toFixed(1)) },
    to: { x: Number((to.x + best.t * u.x).toFixed(1)), y: Number((to.y + best.t * u.y).toFixed(1)) },
    coverage: Number(best.coverage.toFixed(3)),
  };
}

export function findDimensions(paths: GeomPath[]): DimensionRead {
  const geom = { paths };

  const heads = geom.paths.filter(
    (p) => p.paint !== "stroke" && p.points.length >= 3 && p.points.length <= 4 && p.extent >= HEAD_MIN_PT && p.extent <= HEAD_MAX_PT
  );
  const headSet = new Set(heads);
  // Longest edge of a triangle: for an arrowhead that runs along the line it
  // terminates, for a weld dot's ellipse it runs along its own pipe instead.
  const headAxis = (p: GeomPath): Pt => {
    let best = { x: 1, y: 0 };
    let len = 0;
    for (let i = 1; i < p.points.length; i++) {
      const d = dist(p.points[i - 1], p.points[i]);
      if (d > len) {
        len = d;
        best = { x: (p.points[i].x - p.points[i - 1].x) / d, y: (p.points[i].y - p.points[i - 1].y) / d };
      }
    }
    return best;
  };
  /**
   * An arrowhead's APEX -- the vertex off on its own, opposite the base.
   *
   * This is the point that matters, and using the head's CENTRE instead
   * over-reports every span by one arrowhead length. On this drawing the
   * arrows point INWARD, tips on the dimension line: the 184's tips sit at
   * 380.6 and 420.1 (39.5pt apart) while their centres sit at 377.0 and
   * 423.6 (46.6pt apart). The centre-to-centre figure matches no witness
   * line and no piece of pipe.
   */
  const apexOf = (p: GeomPath): Pt => {
    let best = p.points[0];
    let far = -1;
    for (let i = 0; i < p.points.length; i++) {
      const others = p.points.filter((_, j) => j !== i);
      if (others.length < 2) continue;
      const mid = { x: (others[0].x + others[1].x) / 2, y: (others[0].y + others[1].y) / 2 };
      const d = dist(p.points[i], mid);
      if (d > far) {
        far = d;
        best = p.points[i];
      }
    }
    return best;
  };
  const headInfo = heads.map((h) => ({ at: centre(h), apex: apexOf(h), axis: headAxis(h) }));
  // Matched on whichever of the head's APEX or CENTRE is nearer the line's end.
  // The two drawn forms put different parts of the arrow there: an INWARD
  // arrow has its apex exactly on the end, an OUTWARD one sits beyond it with
  // its apex the nearest part and its centre half an arrowhead further out.
  // Centre alone found the upper end of sheet 2's 920 at 2.9pt and missed the
  // lower at 10.5, so the pair never formed and 920mm of N-09 went unread.
  const headNear = (q: Pt, dir: Pt) =>
    headInfo.find(
      (h) =>
        Math.min(dist(h.at, q), h.apex ? dist(h.apex, q) : Infinity) <= HEAD_TOLERANCE_PT &&
        Math.abs(h.axis.x * dir.x + h.axis.y * dir.y) >= HEAD_ALIGN_COS
    );

  // Glyph strokes, for finding the printed number near a dimension's midpoint.
  // Text only: an arrowhead is not a glyph, however small it is.
  const glyphs = geom.paths.filter(
    (p) => p.paint === "stroke" && p.extent <= GLYPH_MAX_PT && p.points.length >= GLYPH_MIN_POINTS && !headSet.has(p)
  );

  /**
   * The number sits near the middle of the span. Take the glyph strokes within
   * reach, standing clear of whatever is actually DRAWN there, and grow ONE
   * text run outward from the one nearest the middle.
   *
   * Measuring against the drawn segments rather than against the whole span is
   * what makes this serve both shapes: a continuous line's own ticks and heads
   * sit on it and are rejected, while a split dimension's number sits in the
   * gap, where nothing is drawn, and is kept.
   */
  const labelFor = (from: Pt, to: Pt, drawn: Array<[Pt, Pt]>): IsoDimension["labelBox"] => {
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const distToSeg = (q: Pt, a: Pt, b: Pt) => {
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (l2 === 0) return dist(q, a);
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / l2));
      return dist(q, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    };
    const clearOfDrawn = (q: Pt) => drawn.every(([a, b]) => distToSeg(q, a, b) > ON_LINE_PT);
    const near = glyphs.filter((g) => {
      const c = centre(g);
      return dist(c, mid) <= LABEL_REACH_PT && clearOfDrawn(c);
    });
    if (near.length === 0) return null;
    // Taking everything within reach instead swallows whatever else is printed
    // nearby -- a weld flag, a cut-piece marker, an item balloon -- and the
    // crop then shows two numbers with no way to tell which is the dimension.
    const sorted = near.slice().sort((g, h) => dist(centre(g), mid) - dist(centre(h), mid));
    const len0 = dist(from, to) || 1;
    const dir = { x: (to.x - from.x) / len0, y: (to.y - from.y) / len0 };
    // ON THE LINE, then nearest -- not nearest outright. The number may sit a
    // long way ALONG the line (a small extent puts it out past the arrowheads,
    // which is where N-15's 305 is printed, 34pt from a 23pt span's midpoint),
    // but it is never far ACROSS it. Nearest-outright picks the "FW" note 17pt
    // away instead, and then grows a perfectly tidy box round it.
    const acrossLine = (q: Pt) => Math.abs((q.x - mid.x) * -dir.y + (q.y - mid.y) * dir.x);
    const first = sorted.find((g) => acrossLine(centre(g)) <= LABEL_ACROSS_PT);
    if (!first) return null;
    const box = { ...first.bbox };
    const used = new Set([first]);
    // The band the text reads along: through the seed glyph, parallel to the
    // dimension itself.
    const seed = centre(first);
    const offBand = (q: Pt) => Math.abs((q.x - seed.x) * -dir.y + (q.y - seed.y) * dir.x);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of sorted) {
        if (used.has(g)) continue;
        if (offBand(centre(g)) > LABEL_BAND_PT) continue;
        const gapX = Math.max(0, box.x0 - g.bbox.x1, g.bbox.x0 - box.x1);
        const gapY = Math.max(0, box.y0 - g.bbox.y1, g.bbox.y0 - box.y1);
        if (Math.hypot(gapX, gapY) > GLYPH_GAP_PT) continue;
        box.x0 = Math.min(box.x0, g.bbox.x0);
        box.y0 = Math.min(box.y0, g.bbox.y0);
        box.x1 = Math.max(box.x1, g.bbox.x1);
        box.y1 = Math.max(box.y1, g.bbox.y1);
        used.add(g);
        grew = true;
      }
    }
    return { x0: box.x0 - LABEL_PAD_PT, y0: box.y0 - LABEL_PAD_PT, x1: box.x1 + LABEL_PAD_PT, y1: box.y1 + LABEL_PAD_PT };
  };

  /**
   * A WITNESS (extension) line runs from the point being measured out to the
   * dimension's tip. Both ends must have one and the two must be PARALLEL --
   * that is exactly the condition under which the drawn dimension length
   * equals the drawn distance between the two measured points, so it is the
   * test for "this brackets a real piece of the drawing" rather than a rule
   * about bores or line weights.
   *
   * Note the witness runs on ANOTHER isometric axis, not perpendicular: on
   * this drawing the 184's two witness lines both run at 30 degrees while the
   * dimension itself is vertical.
   */
  const witnessesAt = (tip: Pt, dimDegrees: number): Array<{ deg: number; len: number }> => {
    const out: Array<{ deg: number; len: number }> = [];
    for (const s of segments) {
      if (s.len < MIN_WITNESS_PT) continue;
      const t = Math.max(0, Math.min(1, ((tip.x - s.a.x) * (s.b.x - s.a.x) + (tip.y - s.a.y) * (s.b.y - s.a.y)) / (s.len * s.len)));
      const near = dist(tip, { x: s.a.x + t * (s.b.x - s.a.x), y: s.a.y + t * (s.b.y - s.a.y) });
      if (near > WITNESS_TOUCH_PT) continue;
      const deg = angleOf(s.a, s.b);
      let off = Math.abs(deg - dimDegrees);
      off = Math.min(off, 180 - off);
      if (off < WITNESS_OFF_AXIS_DEG) continue;
      out.push({ deg, len: s.len });
    }
    return out.sort((x, y) => y.len - x.len);
  };
  const apart = (a: number, b: number) => {
    const off = Math.abs(a - b);
    return Math.min(off, 180 - off);
  };
  const witnessPair = (from: Pt, to: Pt, degrees: number): number | null => {
    const a = witnessesAt(from, degrees);
    const b = witnessesAt(to, degrees);
    // Look for a PARALLEL PAIR across the two ends, rather than taking each
    // end's longest candidate and hoping they agree. Several lines pass close
    // to a tip -- the run itself, a leader, the neighbouring dimension -- and
    // picking the longest at each end independently chose two different ones
    // and failed the parallel test on sheet 3's 721 main-run dimension.
    for (const x of a) for (const y of b) if (apart(x.deg, y.deg) <= WITNESS_PARALLEL_DEG) return Number(((x.deg + y.deg) / 2).toFixed(1));
    // Only one end carrying a witness is normal: where a dimension's end
    // lands straight on the object, none is drawn for it.
    if (a.length > 0 && b.length === 0) return Number(a[0].deg.toFixed(1));
    if (b.length > 0 && a.length === 0) return Number(b[0].deg.toFixed(1));
    return null;
  };

  const dimensions: IsoDimension[] = [];
  const seen = new Set<string>();
  const take = (from: Pt, to: Pt, drawn: Array<[Pt, Pt]>, drawnAs: IsoDimension["drawnAs"]) => {
    // CAD stacks the same line twice often enough to matter.
    const key = `${from.x.toFixed(0)},${from.y.toFixed(0)},${to.x.toFixed(0)},${to.y.toFixed(0)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const degrees = Number(angleOf(from, to).toFixed(1));
    const witnessDegrees = witnessPair(from, to, degrees);
    dimensions.push({
      from,
      to,
      pagePt: Number(dist(from, to).toFixed(1)),
      degrees,
      labelBox: labelFor(from, to, drawn),
      drawnAs,
      measuresPipe: witnessDegrees !== null,
      witnessDegrees,
      attach: pipeAttachment(from, to, witnessDegrees, pipes),
    });
  };

  // The heavy lines: the run itself, which is what a dimension is slid back
  // onto. The same weight test that keeps the pipe OUT of the dimension set
  // is what picks it out here.
  const pipes: Array<{ a: Pt; b: Pt }> = [];
  for (const p of geom.paths) {
    if (p.paint === "fill" || p.lineWidth < PIPE_MIN_LW) continue;
    for (let i = 1; i < p.points.length; i++) {
      if (dist(p.points[i - 1], p.points[i]) > 1) pipes.push({ a: p.points[i - 1], b: p.points[i] });
    }
  }

  // Annotation-weight straight segments on a drawing axis: what either shape
  // is built out of.
  const segments: Array<{ a: Pt; b: Pt; len: number; dir: Pt }> = [];
  for (const p of geom.paths) {
    if (p.paint !== "stroke" || p.points.length !== 2) continue;
    if (p.lineWidth > MAX_ANNOTATION_LW) continue;
    const [a, b] = p.points;
    const len = dist(a, b);
    if (len < MIN_HALF_PT) continue;
    if (!onAxis(angleOf(a, b))) continue;
    segments.push({ a, b, len, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } });
  }

  // --- one line, an arrowhead at each end ---------------------------------
  // `tip` is where the arrow POINTS -- the end of the drawn half, which the
  // head sits at. `head` is only kept to pair the half with its arrowhead.
  const halves: Array<{ head: Pt; tip: Pt; tail: Pt; dir: Pt }> = [];
  for (const s of segments) {
    const ha = headNear(s.a, s.dir);
    const hb = headNear(s.b, s.dir);
    if (ha && hb) {
      // TIP TO TIP -- the arrowhead's APEX is the point being measured to,
      // and it lands on the witness line. Which way the arrow points decides
      // whether that is the drawn line's own end:
      //
      //   pointing INWARD  the apex IS the line's end (sheet 1's 184: base
      //                    at 373.5, apex at 380.6, which is the tip)
      //   pointing OUTWARD the apex is BEYOND it, and the drawn line
      //                    understates the span by an arrowhead at each end
      //
      // CAD draws them outward when the extent is too small to fit the arrows
      // inside. Sheet 1's 305 is drawn that way: a 10.1pt line between apexes
      // 24.3pt apart, both of them exactly on their witness lines. Measuring
      // the LINE made it 10.1pt, under MIN_DIMENSION_PT, so it was thrown
      // away -- and it is the overshoot that has to be subtracted from the
      // 1186 beside it to get N-02's true extent.
      //
      // Taking the apexes covers both, because for an inward arrow the apex
      // and the line's end are the same point.
      //
      // Only where the apexes still describe the SAME LINE, though. An
      // arrowhead can be matched to an end it does not belong to, and the
      // apexes then pull the span off the drawing axis -- which showed up
      // at once as dimensions reported at 21 and 41 degrees. Where that
      // happens the drawn line is the more trustworthy of the two.
      const onSameLine =
        apart(angleOf(ha.apex, hb.apex), angleOf(s.a, s.b)) <= APEX_DRIFT_DEG && onAxis(angleOf(ha.apex, hb.apex));
      const from = onSameLine ? ha.apex : s.a;
      const to = onSameLine ? hb.apex : s.b;
      if (dist(from, to) >= MIN_DIMENSION_PT) take(from, to, [[s.a, s.b]], "line");
      continue;
    }
    // Exactly one end terminated: a candidate half of a split dimension.
    if (ha) halves.push({ head: ha.at, tip: s.a, tail: s.b, dir: s.dir });
    else if (hb) halves.push({ head: hb.at, tip: s.b, tail: s.a, dir: s.dir });
  }

  // --- two halves, the number printed between them ------------------------
  //
  // The halves must lie on ONE line with their ARROWHEADS OUTERMOST. That
  // second part is what keeps a CHAIN of stacked dimensions apart: where two
  // of them meet, their facing halves are collinear too, but both heads are on
  // the INSIDE, at the extension line the two dimensions share.
  //
  // It is also what keeps an EXTENSION line out. A witness line runs from the
  // pipe out to the dimension line and carries a head at only the end where it
  // arrives -- so where two of them are collinear, their heads face inward.
  const splitRejections: SplitRejection[] = [];
  for (let i = 0; i < halves.length; i++) {
    for (let j = i + 1; j < halves.length; j++) {
      const p = halves[i];
      const q = halves[j];
      const perp = { x: -p.dir.y, y: p.dir.x };
      const off = (r: Pt) => Math.abs((r.x - p.tip.x) * perp.x + (r.y - p.tip.y) * perp.y);
      if (off(q.tip) > COLLINEAR_OFFSET_PT || off(q.tail) > COLLINEAR_OFFSET_PT) continue;

      const t = (r: Pt) => (r.x - p.tip.x) * p.dir.x + (r.y - p.tip.y) * p.dir.y;
      const [lo, hi] = t(q.tip) > t(p.tip) ? [p, q] : [q, p];

      const gap = t(hi.tail) - t(lo.tail);
      const span = t(hi.tip) - t(lo.tip);
      const at = { x: (lo.tip.x + hi.tip.x) / 2, y: (lo.tip.y + hi.tip.y) / 2 };
      const reject = (why: SplitRejection["why"]) =>
        splitRejections.push({
          at,
          spanPt: Number(span.toFixed(1)),
          gapPt: Number(gap.toFixed(1)),
          why,
          ends: [lo.tip, hi.tip],
        });

      // heads outermost, tails facing each other, the halves not overlapping
      if (!(t(lo.tip) < t(lo.tail) && t(lo.tail) <= t(hi.tail) && t(hi.tail) < t(hi.tip))) {
        // Tails OUTBOARD, heads facing each other, is a shape this does NOT
        // take, and the reason is worth recording: it is genuinely ambiguous.
        // It is how CAD draws an extent too small to fit its own arrows
        // inside -- but it is also exactly what the JUNCTION of two chained
        // dimensions looks like, where one dimension's closing arrow meets
        // the next one's opening arrow. Measured across the reference ISO's
        // five sheets, every instance was a junction; none was a dimension in
        // its own right. So it is reported, never taken.
        if (t(lo.tail) < t(lo.tip) && t(hi.tip) < t(hi.tail) && span > COLLINEAR_OFFSET_PT) reject("heads face inward");
        continue;
      }

      if (gap < MIN_TEXT_GAP_PT) { reject("gap too small"); continue; }
      if (gap > MAX_TEXT_GAP_PT) { reject("gap too large"); continue; }
      if (span < MIN_DIMENSION_PT) { reject("span too short"); continue; }

      // The gap is only a gap for the NUMBER if the number is in it.
      const drawn: Array<[Pt, Pt]> = [
        [lo.tip, lo.tail],
        [hi.tail, hi.tip],
      ];
      if (!labelFor(lo.tip, hi.tip, drawn)) { reject("no number in the gap"); continue; }
      take(lo.tip, hi.tip, drawn, "split");
    }
  }

  dimensions.sort((a, b) => a.from.y - b.from.y || a.from.x - b.from.x);
  // A chain reaches the same pair of arrowheads twice -- once through the two
  // halves BETWEEN them, which is the dimension, and once through the two
  // stubs OUTSIDE them, which belong to its neighbours. Do not report the
  // second as something missed when the first was taken.
  const taken = new Set(dimensions.map((d) => spanKey(d.from, d.to)));
  const reported = new Set<string>();
  return {
    dimensions,
    splitRejections: splitRejections.filter((r) => {
      const k = spanKey(r.ends[0], r.ends[1]);
      if (taken.has(k) || reported.has(k)) return false;
      reported.add(k);
      return true;
    }),
  };
}

export async function readDimensions(
  filePathOrBuffer: string | Buffer,
  pageNumber: number
): Promise<{ pageNumber: number; width: number; height: number } & DimensionRead> {
  const geom = await readPageGeometry(filePathOrBuffer, pageNumber);
  return { pageNumber, width: geom.width, height: geom.height, ...findDimensions(geom.paths) };
}
