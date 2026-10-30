// Finding the PIPE SUPPORTS on an isometric, off the vector geometry. Free:
// no vision call, no model, nothing to pay for.
//
// DO NOT TRY TO RECOGNISE A SUPPORT SYMBOL. This is the same lesson the spool
// cut finder learned about valves: a support symbol is whatever the CAD
// library happened to contain -- a shoe, a clamp, a guide and a rest are all
// drawn differently, and the reference ISO draws its two types as a bare
// short bar across the pipe with nothing to tell them apart at all.
//
// What IS always the same is that a support is a BOM ITEM, so it carries a
// square item balloon on a leader, exactly like every other item on the
// sheet. And the BOM already says which item numbers are supports. So the
// job is not "find a support" but "find the balloons, and keep the ones the
// BOM calls supports" -- recognition replaced by a lookup against a table
// that was already read.
//
// Three shapes on this drawing carry a number and must not be confused:
//
//   SQUARE box      a BOM item balloon        <- this one
//   HEXAGON flag    a weld number (BW7, FW12)
//   ROUNDED box     a spool tag
//
// isoWeldMarks.ts already keys on the hexagon and isoSpoolTags.ts on the wide
// rounded box; this keys on the square, and the three are disjoint.
import { readPageGeometry, type GeomPath, type Point } from "../pdfGeometry";

export type Pt = Point;

/**
 * An item balloon: the box, and the point on the pipe its leader arrives at.
 */
export interface BalloonHit {
  /** The box, for cropping it so the number inside can be read. */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Where the leader stops. */
  tip: Pt;
  /** That tip put onto the nearest run segment -- the thing being named. */
  at: Pt;
  /** How far the tip sat off the run. Large means it points at something else. */
  offRunPt: number;
  /** Length of the leader, for telling a real one from a stray stroke. */
  leaderPt: number;
}

/** A balloon whose number has been read, and which the BOM calls a support. */
export interface PipeSupportHit extends BalloonHit {
  /**
   * The BALLOON's own cell on the contact sheet, kept as it was.
   *
   * Not renumbered by position among the supports: the cell names index a
   * saved `--labels-from` reading, so re-deriving them from a filtered list
   * would silently repoint every label at a different balloon the next time
   * a support is added or dropped.
   */
  cell: string;
  itemNo: string;
  /** The BOM's own words for it, e.g. "PRIMARY SUPPORT - SC101". */
  description: string;
  typeCode: string | null;
  role: "primary" | "secondary" | "unstated";
}

/**
 * An item balloon is a SQUARE-ISH box about as tall as a line of text.
 *
 * Measured on the reference ISO, where every balloon is 21.0 x 18.2pt for a
 * one-or-two digit number and 21.1 x 24.3pt where the box is taller. Bounded
 * generously in both directions because a three-digit item number widens the
 * box, and tightened instead by REQUIRING A LEADER -- which is what actually
 * separates a balloon from the BOM table's own cells, of which this page has
 * several hundred at very similar sizes.
 */
const BOX_MIN_PT = 8;
const BOX_MAX_PT = 40;

/** A leader is a thin line; the pipe is the heavy one. Same split as everywhere. */
const MAX_LEADER_LW = 1.5;
const PIPE_MIN_LW = 1.5;

/** A leader touches its box, give or take the gap CAD leaves. */
const LEAVES_BOX_PT = 3;
/** ...and goes somewhere. Shorter than this and it is part of the box. */
const MIN_LEADER_PT = 6;

/**
 * How far a leader tip may sit off the run and still be pointing at it.
 *
 * A support leader stops AT the support bar, which is drawn across the pipe
 * and so stands off the centreline by half its own length. Measured on the
 * reference ISO the tips land 0.5-9pt off; 20 leaves room for a longer bar
 * without reaching the next parallel leg, which is never nearer than 40pt.
 */
const MAX_OFF_RUN_PT = 20;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from a point to a box, zero inside it. */
function gapToBox(b: { x0: number; y0: number; x1: number; y1: number }, p: Pt): number {
  const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
  const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
  return Math.hypot(dx, dy);
}

/** The nearest point on segment a-b to p, and how far that is. */
function projectOnSegment(p: Pt, a: Pt, b: Pt): { at: Pt; d: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { at: a, d: dist(p, a) };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  const at = { x: a.x + t * vx, y: a.y + t * vy };
  return { at, d: dist(p, at) };
}

function isBalloonBox(p: GeomPath): boolean {
  if (p.paint !== "stroke" && p.paint !== "fillStroke") return false;
  // 4 corners, usually with the first repeated to close it.
  if (p.points.length < 4 || p.points.length > 6) return false;
  const w = p.bbox.x1 - p.bbox.x0;
  const h = p.bbox.y1 - p.bbox.y0;
  if (w < BOX_MIN_PT || w > BOX_MAX_PT || h < BOX_MIN_PT || h > BOX_MAX_PT) return false;
  // Squarish. A wide flat box is a spool tag or a note; a tall thin one is a
  // table rule. The reference ISO's balloons run 0.86 to 1.15 tall over wide.
  const ratio = w / h;
  return ratio > 0.4 && ratio < 2.5;
}

/**
 * Every item balloon on the page that leaders to the pipe.
 *
 * A balloon with no leader is a table cell; a leader that lands nowhere near
 * the run is naming something that is not on it. Both drop out here, which is
 * what makes the size bounds above safe to leave loose.
 */
export function findItemBalloons(paths: GeomPath[]): BalloonHit[] {
  const boxes = paths.filter(isBalloonBox);
  const thin: Array<{ a: Pt; b: Pt; len: number }> = [];
  const pipes: Array<{ a: Pt; b: Pt }> = [];
  for (const p of paths) {
    for (let i = 1; i < p.points.length; i++) {
      const a = p.points[i - 1];
      const b = p.points[i];
      const len = dist(a, b);
      if (len <= 1) continue;
      if (p.paint !== "fill" && p.lineWidth <= MAX_LEADER_LW && len > MIN_LEADER_PT) thin.push({ a, b, len });
      if (p.lineWidth >= PIPE_MIN_LW) pipes.push({ a, b });
    }
  }

  const out: BalloonHit[] = [];
  for (const box of boxes) {
    // The LONGEST segment leaving this box is its leader. A box has four
    // sides that all start at it, so length is what tells the leader from the
    // box's own edges -- and the edges are excluded anyway by having both
    // ends on the box.
    let tip: Pt | null = null;
    let leaderPt = 0;
    for (const s of thin) {
      const da = gapToBox(box.bbox, s.a);
      const db = gapToBox(box.bbox, s.b);
      if (Math.min(da, db) > LEAVES_BOX_PT) continue;
      const end = da < db ? s.b : s.a;
      // Both ends on the box: that is a side of the box, not a leader.
      if (gapToBox(box.bbox, end) <= LEAVES_BOX_PT) continue;
      if (s.len > leaderPt) {
        leaderPt = s.len;
        tip = end;
      }
    }
    if (!tip) continue;

    let at: Pt | null = null;
    let offRunPt = Infinity;
    for (const seg of pipes) {
      const { at: on, d } = projectOnSegment(tip, seg.a, seg.b);
      if (d < offRunPt) {
        offRunPt = d;
        at = on;
      }
    }
    if (!at || offRunPt > MAX_OFF_RUN_PT) continue;
    out.push({ box: box.bbox, tip, at, offRunPt, leaderPt });
  }

  // CAD stacks a box on itself where a layer is drawn twice, and the same
  // balloon must not become two supports.
  const seen: BalloonHit[] = [];
  for (const hit of out.sort((a, b) => a.box.x0 - b.box.x0 || a.box.y0 - b.box.y0)) {
    if (seen.some((s) => gapToBox(s.box, { x: hit.box.x0, y: hit.box.y0 }) < 1 && Math.abs(s.box.x1 - hit.box.x1) < 1)) continue;
    seen.push(hit);
  }
  return seen;
}

export interface BalloonPage {
  pageNumber: number;
  width: number;
  height: number;
  balloons: BalloonHit[];
}

export async function readItemBalloons(filePathOrBuffer: string | Buffer, pageNumber: number): Promise<BalloonPage> {
  const geom = await readPageGeometry(filePathOrBuffer, pageNumber);
  return { pageNumber, width: geom.width, height: geom.height, balloons: findItemBalloons(geom.paths) };
}

/** Which BOM rows are supports, keyed by the item number their balloon carries. */
export interface SupportItemRow {
  itemNo: string;
  description: string;
  quantity: number;
}

const ROLE = (text: string): "primary" | "secondary" | "unstated" =>
  /\bprimary\b/i.test(text) ? "primary" : /\bsecondary\b/i.test(text) ? "secondary" : "unstated";

/**
 * The support's catalogue designation -- SC101, RB103, SW100.
 *
 * Letters then digits with NO hyphen, which is what the project's support
 * standard uses. Deliberately not the ISA tag shape: an instrument tag and a
 * support code would otherwise read each other's, and a support is not an
 * instrument.
 */
export function supportTypeCode(text: unknown): string | null {
  const m = String(text ?? "").toUpperCase().match(/\b([A-Z]{2,3}\d{2,4})\b/);
  return m ? m[1] : null;
}

/**
 * Keep the balloons the BOM calls supports.
 *
 * `labels` maps a balloon's cell name to the number read out of it. Reading
 * is the only step that needs eyes, and it is done off a contact sheet -- the
 * same arrangement as the weld flags and the spool tags.
 */
export function pipeSupportsOf(
  balloons: BalloonHit[],
  labels: Record<string, string>,
  supportItems: SupportItemRow[],
  page: number
): PipeSupportHit[] {
  const byItem = new Map(supportItems.map((r) => [r.itemNo.trim(), r]));
  const out: PipeSupportHit[] = [];
  balloons.forEach((b, i) => {
    const cell = `${page}-${i + 1}`;
    const itemNo = (labels[cell] ?? "").trim();
    const row = byItem.get(itemNo);
    if (!row) return;
    out.push({
      ...b,
      cell,
      itemNo,
      description: row.description,
      typeCode: supportTypeCode(row.description),
      role: ROLE(row.description),
    });
  });
  return out;
}

/**
 * How many supports the BOM says are on this sheet, against how many were
 * found.
 *
 * The BOM is a TABLE and its quantities are the number to trust; the drawing
 * is where a symbol can be missed. So this is a real check, not a formality,
 * and the same shape as `numberingComplete` for weld flags: a detector that
 * cannot say whether it found everything has not finished.
 */
export function supportCountCheck(
  found: PipeSupportHit[],
  supportItems: SupportItemRow[]
): { complete: boolean; expected: number; found: number; perItem: Array<{ itemNo: string; expected: number; found: number }> } {
  const perItem = supportItems.map((row) => ({
    itemNo: row.itemNo,
    expected: row.quantity,
    found: found.filter((f) => f.itemNo === row.itemNo).length,
  }));
  const expected = supportItems.reduce((n, r) => n + r.quantity, 0);
  return { complete: perItem.every((p) => p.found === p.expected), expected, found: found.length, perItem };
}

/* ---- the spans between supports ----------------------------------------- */
//
// THE SPAN IS A PRINTED DIMENSION, NEVER A PAGE MEASUREMENT. An isometric is
// not drawn to scale -- this repo has one run at 14.3 mm/pt and another at
// 11.0 on the same sheet -- so the distance between two supports can only be
// READ, and page geometry is good for one thing only: saying WHICH printed
// lengths lie between them.
//
// What makes that work here is that the draughtsman breaks the dimension
// chain AT each support. On the reference ISO's page 1 the chain along the
// east run runs elbow -> 1500 -> support -> 1000 -> support -> 937 -> elbow,
// so each span is a whole number of printed legs and nothing has to be
// interpolated. Where a support sits mid-leg instead, no exact span can be
// formed from the printed lengths and this says so rather than apportioning
// the leg by page distance, which would be measuring off the drawing again.

/** One printed dimension, as the geometry found it: where it attaches, and its read value. */
export interface DimensionLeg {
  cell: string;
  /** The value read off the label. Null where it was never read. */
  mm: number | null;
  /** The ends of the pipe this dimension measures, slid onto the run. */
  from: Pt;
  to: Pt;
  /** The drawn axis, for counting direction changes along a span. */
  degrees: number;
}

/**
 * Two attach ends this close are the same point on the run.
 *
 * Same job and roughly the same figure as spoolShape's JOIN_PT: attach points
 * are computed by sliding a dimension onto the pipe, so two legs meeting at
 * an elbow land together to within rounding. Measured on page 1 of the
 * reference ISO the chain's joints agree to under 1pt, and consecutive
 * supports are never closer than 90pt, so there is a wide gap to sit in.
 */
const JOIN_PT = 6;

/**
 * How near a support has to be to a chain node to be AT it.
 *
 * Measured: the three supports on page 1 land 3.6, 5.8 and 6.7pt from their
 * node, because the leader stops at the support bar rather than on the
 * centreline. 12 covers that with room and is far under the ~90pt to the
 * next node.
 */
const AT_NODE_PT = 12;

export interface SupportSpanHit {
  /**
   * A gap BETWEEN two supports, or the pipe from a support to the END of the
   * dimensioned run.
   *
   * THE GAPS BETWEEN SUPPORTS ARE NOT THE WHOLE QUESTION. A run has two ends,
   * and the pipe from the last support to the end of it is unsupported just
   * the same -- so a sheet whose every span passes can still have a long
   * unheld stretch at either end, and reporting only the middles hides it.
   *
   * A "run-end" is reported, not failed. The end of a DIMENSION CHAIN is not
   * necessarily the end of the pipe: it can be an anchor, an equipment
   * nozzle, a dead end, or the point where the line carries on to the next
   * sheet. What holds it there is usually not on this drawing, so the length
   * and the verdict are given and the reader decides.
   */
  kind: "span" | "run-end";
  /** The support cells at either end. For a run-end, one of them is "(run end)". */
  fromCell: string;
  toCell: string;
  /** The printed dimensions this span is made of, in order. */
  legs: string[];
  /** Their total. Null where any of them was never read. */
  mm: number | null;
  /** How many times the run changes direction between the two supports. */
  turns: number;
  /** The vertical legs inside the span, which the standard limits separately. */
  verticalLegMm: number | null;
}

const angleClose = (a: number, b: number) => {
  const d = Math.abs(((a - b) % 180) + 180) % 180;
  return Math.min(d, 180 - d) < 10;
};

/**
 * Chain the dimension legs into runs, then read off the spans between
 * consecutive supports.
 *
 * Forks are left alone rather than guessed through, for the same reason
 * `chainLegs` refuses them: taking one arm silently drops the other, and the
 * dropped arm is real pipe carrying real weight.
 */
export function supportSpans(legs: DimensionLeg[], supports: PipeSupportHit[]): SupportSpanHit[] {
  const near = (a: Pt, b: Pt) => dist(a, b) <= JOIN_PT;
  const used = new Set<string>();
  const out: SupportSpanHit[] = [];

  for (const seed of legs) {
    if (used.has(seed.cell)) continue;

    // Walk out from this leg in both directions, refusing a fork.
    const chain: DimensionLeg[] = [seed];
    used.add(seed.cell);
    for (const forward of [true, false]) {
      let end = forward ? seed.to : seed.from;
      for (;;) {
        const next = legs.filter((l) => !used.has(l.cell) && (near(l.from, end) || near(l.to, end)));
        if (next.length !== 1) break;
        const l = next[0];
        used.add(l.cell);
        if (forward) chain.push(l);
        else chain.unshift(l);
        end = near(l.from, end) ? l.to : l.from;
      }
    }

    // Put the chain in walk order, so each leg's `to` is the next leg's `from`.
    const nodes: Pt[] = [];
    const ordered: Array<{ leg: DimensionLeg; at: number }> = [];
    let cursor = chain.length > 1 && (near(chain[0].to, chain[1].from) || near(chain[0].to, chain[1].to)) ? chain[0].from : chain[0].to;
    if (chain.length === 1) cursor = chain[0].from;
    nodes.push(cursor);
    for (const leg of chain) {
      const start = near(leg.from, cursor) ? leg.from : leg.to;
      const finish = start === leg.from ? leg.to : leg.from;
      if (!near(start, cursor)) break; // not actually connected; stop here
      ordered.push({ leg, at: nodes.length - 1 });
      nodes.push(finish);
      cursor = finish;
    }
    if (ordered.length === 0) continue;

    // Which node each support sits on. A support that matches no node sits
    // mid-leg and cannot be given an exact span from printed lengths.
    const onNode = supports
      .map((s) => {
        let best = Infinity;
        let index = -1;
        nodes.forEach((n, i) => {
          const d = dist(n, s.at);
          if (d < best) {
            best = d;
            index = i;
          }
        });
        return { s, index, d: best };
      })
      .filter((x) => x.d <= AT_NODE_PT)
      .sort((a, b) => a.index - b.index);

    // A primary and its secondary sit at the same point -- one support POINT,
    // not two. Collapsing them here is what stops a zero-length span being
    // reported between a support and the one installed on top of it.
    const points: Array<{ cell: string; index: number }> = [];
    for (const hit of onNode) {
      if (points.some((p) => p.index === hit.index)) continue;
      points.push({ cell: hit.s.cell, index: hit.index });
    }

    // Every stretch on the chain, in order: the pipe before the first
    // support, each gap between two, and the pipe after the last.
    const RUN_END = "(run end)";
    const stretches: Array<{ from: string; to: string; lo: number; hi: number; kind: "span" | "run-end" }> = [];
    if (points.length > 0) {
      const first = points[0];
      if (first.index > 0) stretches.push({ from: RUN_END, to: first.cell, lo: 0, hi: first.index, kind: "run-end" });
      for (let i = 1; i < points.length; i++)
        stretches.push({ from: points[i - 1].cell, to: points[i].cell, lo: points[i - 1].index, hi: points[i].index, kind: "span" });
      const last = points[points.length - 1];
      if (last.index < ordered.length) stretches.push({ from: last.cell, to: RUN_END, lo: last.index, hi: ordered.length, kind: "run-end" });
    }

    for (const stretch of stretches) {
      const a = { cell: stretch.from, index: stretch.lo };
      const b = { cell: stretch.to, index: stretch.hi };
      const between = ordered.filter((o) => o.at >= a.index && o.at < b.index);
      if (between.length === 0) continue;
      const mm = between.every((o) => o.leg.mm != null) ? between.reduce((n, o) => n + (o.leg.mm ?? 0), 0) : null;
      let turns = 0;
      for (let k = 1; k < between.length; k++) if (!angleClose(between[k].leg.degrees, between[k - 1].leg.degrees)) turns++;
      // A vertical leg is drawn straight up the page: on an isometric the
      // elevation axis is never tilted, so 90 degrees is a rise or a drop and
      // nothing else.
      const vertical = between.filter((o) => angleClose(o.leg.degrees, 90) && o.leg.mm != null);
      out.push({
        kind: stretch.kind,
        fromCell: a.cell,
        toCell: b.cell,
        legs: between.map((o) => o.leg.cell),
        mm,
        turns,
        verticalLegMm: vertical.length > 0 ? Math.max(...vertical.map((o) => o.leg.mm ?? 0)) : null,
      });
    }
  }

  return out;
}

/**
 * The spans, but ONLY once every support on the sheet has been read.
 *
 * READ THE SUPPORTS THROUGH FIRST, THEN DO THE SPAN. The order is not
 * housekeeping -- it is what makes a span mean anything. A span is the gap
 * between two CONSECUTIVE supports, and "consecutive" is only knowable once
 * they have all been found. Miss one and the two either side of it pair with
 * each other, and the sheet reports a single long gap where the drawing has
 * two short ones:
 *
 *   found 18-1 ....... 18-2 ....... 18-3      spans 1000, 1437   correct
 *   missed the middle  18-1 ................. 18-3      span 2437   invented
 *
 * Both failures follow, and they point opposite ways. The invented 2437 can
 * exceed the standard and send someone to add a support that is already
 * there; and on a sheet where the missing one was at the END, the last real
 * span is simply never reported, so an over-long gap passes in silence. A
 * check that can fail in both directions on the same input is not a check.
 *
 * So the BOM's own quantity is the gate. It is a TABLE -- it was read once,
 * it does not depend on finding a symbol, and it is the only thing on the
 * sheet that knows how many supports there are supposed to be. Where the
 * count does not match, no span is computed and the reason is returned in
 * its place. Same rule the spool cut finder follows when its cut count
 * disagrees with the printed spool count: leave the sheet alone, never guess
 * at it.
 */
export function supportSpansWhenComplete(
  legs: DimensionLeg[],
  supports: PipeSupportHit[],
  check: ReturnType<typeof supportCountCheck>
): { spans: SupportSpanHit[]; withheld: string | null } {
  if (check.expected === 0) {
    return { spans: [], withheld: null };
  }
  if (!check.complete) {
    const short = check.perItem.filter((p) => p.found !== p.expected);
    return {
      spans: [],
      withheld:
        `the BOM calls for ${check.expected} support${check.expected === 1 ? "" : "s"} on this sheet and ${check.found} ` +
        `${check.found === 1 ? "was" : "were"} located (${short.map((p) => `item ${p.itemNo}: ${p.found} of ${p.expected}`).join(", ")}). ` +
        `No span is measured until every support is found, because a missed support merges the two gaps either side of it into one that is not there.`,
    };
  }
  return { spans: supportSpans(legs, supports), withheld: null };
}
