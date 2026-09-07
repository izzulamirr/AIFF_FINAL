// Plate nesting for cutting plans.
//
// The AI reads the item list off the drawing; THIS decides where each part
// sits on the plate. Nesting is arithmetic, not judgement -- the same part
// list and the same stock must always give the same layout, or a fabricator
// cannot check the plan, re-issue it, or hold anyone to it. So the layout is
// computed here, deterministically, and the model is never asked to
// "arrange" anything.
//
// THE BUFFER IS THE POINT. A plasma torch does not cut along a line, it burns
// a channel of finite width -- the KERF -- centred on the path it is given.
// The CNC control offsets the path outward by half a kerf so the finished
// edge lands on the nominal outline, which is what keeps a 300 mm plate 300
// mm after cutting. That offset consumes real material, so two parts placed
// closer than one kerf apart share metal that will not exist once both are
// cut: the second cut runs into the first part's edge and takes the size off
// it. Spacing therefore carries the whole kerf, plus a web of solid material
// so the strip between two cuts does not sag or pull as it heats.
//
//   part-to-part spacing = kerf + web
//
// The edge margin is a separate allowance: a rolled plate's own edge carries
// mill scale, is out of square, and is where the plate was handled, so parts
// are held back from it rather than cut against it.
//
// WHAT IS NESTED IS THE BOUNDING BOX, not the true profile. A cutting-plate
// drawing dimensions each part inside a box and that box is what this
// reserves. For a concave part -- a gusset with a pipe radius bitten out of
// it -- the box reserves metal the part does not use, and a true-shape nester
// would fit another part into that bite. Doing that needs the real outline,
// which a plotted PDF does not carry (see the cutting extractor), so the
// plates counted here are an honest upper bound rather than a floor.

export const CUT_SHAPES = ["rectangle", "circle", "profile"] as const;
export type CutShape = (typeof CUT_SHAPES)[number];

// ---------------------------------------------------------------------------
// Cutting allowances
//
// These are not preferences, so nobody is asked to type them. Kerf is a
// property of the process and the plate: a plasma nozzle sized for 20 mm
// plate burns a wider channel than one sized for 6 mm, and the figure is
// whatever that nozzle takes out. The web and the edge margin follow the
// plate too -- thicker plate holds more heat, so the strip of solid metal
// between two cuts has to be heavier or it sags and pulls the parts out of
// size, and the as-rolled edge is proportionally worse on heavy plate.
//
// So the allowances are DERIVED from the thickness being cut, and then the
// nester searches the band above that minimum for the most generous spacing
// that still fits the job on the same number of plates. Generous spacing is
// free right up to the moment it costs a plate; below the derived minimum it
// is not spacing that is saved, it is tolerance.
// ---------------------------------------------------------------------------

// Conventional air plasma on structural plate. The bands are the nozzle
// sizes a shop actually steps through, not a formula -- you cannot buy a
// consumable between two of them.
export function plasmaKerfMm(thicknessMm: number): number {
  if (thicknessMm <= 3) return 1.5;
  if (thicknessMm <= 6) return 2.0;
  if (thicknessMm <= 10) return 2.5;
  if (thicknessMm <= 16) return 3.0;
  if (thicknessMm <= 25) return 4.0;
  if (thicknessMm <= 32) return 5.0;
  if (thicknessMm <= 50) return 6.0;
  return 7.0;
}

export interface Allowances {
  kerfMm: number;
  webMm: number;
  edgeMarginMm: number;
  spacingMm: number; // kerf + web: the gap the torch actually leaves
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// The floor: below this the cut stops being trustworthy. Web at least as
// heavy as the plate is the common shop rule, with a 6 mm floor because thin
// plate distorts from heat faster than it does from a thin web, and a 20 mm
// ceiling because past that the heat argument stops paying for the plate it
// eats. The edge margin follows the same shape against the rolled edge.
export function minimumAllowances(thicknessMm: number): Allowances {
  const kerfMm = plasmaKerfMm(thicknessMm);
  const webMm = clamp(Math.round(thicknessMm), 6, 20);
  return { kerfMm, webMm, edgeMarginMm: clamp(Math.round(thicknessMm), 10, 25), spacingMm: kerfMm + webMm };
}

// The comfortable end of the band -- what a shop would run given the room.
// Nothing above this buys any more safety, it only wastes plate.
//
// Both figures are floored at the minimum. Without that the band inverts on
// heavy plate -- a 40 mm plate wants a 40 mm web, which is past the 30 mm
// ceiling here -- and the ladder would then offer "generous" settings TIGHTER
// than the safe floor, which is exactly the mistake this whole derivation
// exists to prevent.
export function generousAllowances(thicknessMm: number): Allowances {
  const min = minimumAllowances(thicknessMm);
  const kerfMm = min.kerfMm;
  const webMm = Math.max(min.webMm, clamp(Math.round(thicknessMm * 2), 12, 30));
  return {
    kerfMm,
    webMm,
    edgeMarginMm: Math.max(min.edgeMarginMm, clamp(Math.round(thicknessMm * 1.5), 20, 40)),
    spacingMm: kerfMm + webMm,
  };
}

// The allowance ladder searched for one thickness, most generous first. The
// nester walks it downward and stops caring once tightening stops saving a
// plate, which is what makes the chosen figure defensible: it is the loosest
// setting the job can afford.
export function allowanceCandidates(thicknessMm: number): Allowances[] {
  const min = minimumAllowances(thicknessMm);
  const max = generousAllowances(thicknessMm);
  const kerfMm = min.kerfMm;

  const webs: number[] = [];
  const steps = 5;
  for (let i = steps; i >= 0; i--) {
    const web = Math.round(min.webMm + ((max.webMm - min.webMm) * i) / steps);
    if (!webs.includes(web)) webs.push(web);
  }
  const edges = max.edgeMarginMm === min.edgeMarginMm ? [min.edgeMarginMm] : [max.edgeMarginMm, min.edgeMarginMm];

  const out: Allowances[] = [];
  for (const edgeMarginMm of edges) {
    for (const webMm of webs) out.push({ kerfMm, webMm, edgeMarginMm, spacingMm: kerfMm + webMm });
  }
  return out;
}

export interface CutPart {
  id: string;
  partNo: string;
  description: string | null;
  shape: CutShape;
  // The part's BOUNDING BOX -- what the nest has to reserve. For a rectangle
  // that is the part; for a circle the diameter square; for a cut profile the
  // overall extent the drawing dimensions it over.
  lengthMm: number;
  widthMm: number;
  // Null where the drawing states no thickness, which is normal on a cutting
  // sheet plotted from model space. Such a part is cut from whatever plate is
  // on the table, so it is nested against the stock and the assumption is
  // reported rather than the part being dropped.
  thicknessMm: number | null;
  material: string | null;
  quantity: number;
  // False where the drawing calls out a rolling/grain direction, in which
  // case turning the part 90 degrees would satisfy the geometry and violate
  // the spec.
  rotatable: boolean;
  // The part as actually drawn: an SVG path in millimetres, origin at the top
  // left of the bounding box. Present when the geometry came from CAD, absent
  // when only dimensions could be read. It is carried through the nest purely
  // so the layout can show the real outline -- what is RESERVED is still the
  // box, and drawing the true shape inside it is what makes the difference
  // between the two visible to whoever is cutting.
  outlinePath?: string | null;
  // The same outline as point loops, which is what the true-shape nester
  // rasterises. Present only for parts read from CAD.
  outlineRings?: Array<Array<[number, number]>> | null;
  // Per ring: whether it closes, and whether it is metal removed rather than
  // metal kept. Neither can be recovered from the geometry afterwards -- a
  // circle drawn on a part is as often a boss standing proud of it as a hole
  // through it, and only the CAD read knows which -- so it travels with the
  // rings rather than being guessed at downstream.
  outlineRingInfo?: Array<{ closed: boolean; hole: boolean }> | null;
  // Area of the metal itself, bounding box minus what the profile does not
  // use. Lets the plan report the true utilisation next to the reserved one.
  netAreaMm2?: number | null;
}

/**
 * The extent of an outline in its own frame.
 *
 * A part's box and its outline have to agree, and the outline is the one that
 * cannot be wrong -- it is the geometry. So where rings are present the box is
 * measured off them rather than trusted from whatever recorded it.
 */
export function outlineExtentMm(rings: Array<Array<[number, number]>>): { lengthMm: number; widthMm: number } | null {
  let maxX = 0;
  let maxY = 0;
  let any = false;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      any = true;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return any && maxX > 0 && maxY > 0 ? { lengthMm: maxX, widthMm: maxY } : null;
}

export interface StockPlate {
  id: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  material: string | null;
  // How many plates of this size the job may use. Plate is bought, so "as
  // many as it takes" is not a real answer -- a nest that opens a fifth plate
  // when the yard holds four is a plan the shop cannot run. Left undefined the
  // count is unlimited, which is the right default when the question being
  // asked is "how much plate should I order?" rather than "will it fit?".
  quantity?: number | null;
}

export interface NestOptions {
  allowRotation?: boolean;
}

export interface Placement {
  partId: string;
  partNo: string;
  shape: CutShape;
  instance: number; // 1-based, within that part's quantity
  x: number; // mm from the plate's left edge, to the part's own outline
  y: number; // mm from the plate's top edge
  w: number;
  h: number;
  rotated: boolean;
  // Carried from the part so a layout can draw the profile in place. In the
  // part's own unrotated frame -- a renderer that turned the box 90 degrees
  // has to turn the path with it.
  //
  // EXCEPT where rotationDeg is set: the true-shape nester turns parts by
  // arbitrary angles, which `rotated` cannot express, so it bakes the turn
  // into the path and leaves `rotated` false. A renderer must therefore turn
  // the path only on `rotated`, never on `rotationDeg`.
  outlinePath?: string | null;
  // The same outline as loops, already turned, each carrying whether it closes
  // and whether it is a hole. Where this is present it is the truth and the
  // path is only a convenience for drawing.
  outlineLoops?: Array<{ points: Array<[number, number]>; closed: boolean; hole: boolean }> | null;
  // The angle the part was actually turned by, for the cut list. Absent from a
  // box nest, where the only options are 0 and 90 and `rotated` says which.
  rotationDeg?: number;
}

export interface NestedPlate {
  index: number; // 1-based, across the whole plan
  stockId: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  material: string | null;
  // The allowances this plate was actually cut to. They live per plate
  // because they are derived from thickness, and a job across 10 mm and
  // 25 mm plate is cut to two different sets.
  allowances: Allowances;
  placements: Placement[];
  partAreaMm2: number;
  plateAreaMm2: number;
  utilisation: number; // 0..1, bounding-box area over plate area
  // The biggest rectangle of plate left whole -- what the shop can put back
  // on the rack as a remnant rather than weigh in as drop. Approximate: it is
  // measured off the packer's free space with the cutting spacing taken back
  // off, so it is a figure to reach for a tape with, not to cut to.
  largestOffcut: { lengthMm: number; widthMm: number } | null;
}

export interface UnplacedPart {
  part: CutPart;
  quantity: number;
  reason: string;
}

// What was chosen for one thickness, and why -- so the allowances can be
// checked by the person who has to sign the plan off rather than taken on
// trust because a machine picked them.
export interface AllowancePlan {
  thicknessMm: number;
  material: string | null;
  allowances: Allowances;
  minimum: Allowances;
  plateCount: number;
  // True when the loosest spacing in the band was affordable -- i.e. nothing
  // was given up to fit the job.
  atMostGenerous: boolean;
  // The plate count the tightest safe spacing would have reached. Equal to
  // plateCount whenever tightening buys nothing, which is the common case.
  plateCountAtMinimum: number;
  basis: string;
}

// How much of each stock row the plan actually consumed, so the page can say
// "2 of the 3 plates you hold" rather than leaving the count to be inferred
// from the number of layouts drawn.
export interface StockUsage {
  stockId: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  material: string | null;
  // null = no limit was set on this row.
  available: number | null;
  used: number;
  // True when the plan wanted more plates of this size than were available.
  short: boolean;
}

export interface NestResult {
  plates: NestedPlate[];
  unplaced: UnplacedPart[];
  // One entry per thickness/grade nested, in plate order.
  allowancePlans: AllowancePlan[];
  // Part numbers nested against a thickness the drawing never stated. Shown
  // rather than buried: the plan is only right if that plate is the one that
  // actually goes on the table.
  assumedThicknessParts: string[];
  // One entry per stock row the nest drew on, in plate order.
  stockUsage: StockUsage[];
  totals: {
    plateCount: number;
    // Plates the stock list says are available, summed over the rows this
    // nest used. null when any of those rows is unlimited.
    plateCountAvailable: number | null;
    plateAreaM2: number;
    partAreaM2: number;
    wasteM2: number;
    utilisation: number; // 0..1
  };
}

// ---------------------------------------------------------------------------
// MaxRects packing
//
// The plate is held as a list of maximal free rectangles; placing a part
// splits every free rectangle it overlaps, and the ones left contained in
// another are pruned. Chosen over shelf/row packing because a cutting item
// list is a mix of long arms and small pads, and shelf packing pays for every
// mixed row twice -- once in the band of air above the short parts, again in
// the offcut it fragments.
// ---------------------------------------------------------------------------

type FitHeuristic = "short-side" | "long-side" | "area";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PlacedRect extends Rect {
  rotated: boolean;
}

const EPS = 1e-6;

function splitFreeRect(free: Rect, used: Rect, out: Rect[]): boolean {
  if (
    used.x >= free.x + free.w - EPS ||
    used.x + used.w <= free.x + EPS ||
    used.y >= free.y + free.h - EPS ||
    used.y + used.h <= free.y + EPS
  ) {
    return false;
  }

  if (used.x < free.x + free.w && used.x + used.w > free.x) {
    if (used.y > free.y && used.y < free.y + free.h) {
      out.push({ x: free.x, y: free.y, w: free.w, h: used.y - free.y });
    }
    if (used.y + used.h < free.y + free.h) {
      out.push({ x: free.x, y: used.y + used.h, w: free.w, h: free.y + free.h - (used.y + used.h) });
    }
  }
  if (used.y < free.y + free.h && used.y + used.h > free.y) {
    if (used.x > free.x && used.x < free.x + free.w) {
      out.push({ x: free.x, y: free.y, w: used.x - free.x, h: free.h });
    }
    if (used.x + used.w < free.x + free.w) {
      out.push({ x: used.x + used.w, y: free.y, w: free.x + free.w - (used.x + used.w), h: free.h });
    }
  }
  return true;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  );
}

class MaxRectsBin {
  private free: Rect[];

  constructor(w: number, h: number) {
    this.free = [{ x: 0, y: 0, w, h }];
  }

  insert(w: number, h: number, allowRotate: boolean, heuristic: FitHeuristic): PlacedRect | null {
    let best: PlacedRect | null = null;
    let bestPrimary = Infinity;
    let bestSecondary = Infinity;

    for (const f of this.free) {
      const consider = (rw: number, rh: number, rotated: boolean) => {
        if (rw > f.w + EPS || rh > f.h + EPS) return;
        const leftoverH = f.w - rw;
        const leftoverV = f.h - rh;
        const shortSide = Math.min(leftoverH, leftoverV);
        const longSide = Math.max(leftoverH, leftoverV);
        const primary = heuristic === "area" ? f.w * f.h - rw * rh : heuristic === "long-side" ? longSide : shortSide;
        const secondary = heuristic === "area" ? shortSide : heuristic === "long-side" ? shortSide : longSide;
        if (primary < bestPrimary - EPS || (Math.abs(primary - bestPrimary) < EPS && secondary < bestSecondary - EPS)) {
          bestPrimary = primary;
          bestSecondary = secondary;
          best = { x: f.x, y: f.y, w: rw, h: rh, rotated };
        }
      };
      consider(w, h, false);
      if (allowRotate && Math.abs(w - h) > EPS) consider(h, w, true);
    }

    if (!best) return null;
    this.place(best);
    return best;
  }

  private place(used: Rect) {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (!splitFreeRect(f, used, next)) next.push(f);
    }
    this.free = next.filter((r, i) => {
      if (r.w <= EPS || r.h <= EPS) return false;
      // Drop any rectangle already covered by another. Identical duplicates
      // would otherwise delete each other, so of an equal pair only the later
      // index goes.
      return !next.some((other, j) => {
        if (i === j || other.w <= EPS || other.h <= EPS) return false;
        if (!contains(other, r)) return false;
        const areaOther = other.w * other.h;
        const areaR = r.w * r.h;
        return areaOther > areaR + EPS || (Math.abs(areaOther - areaR) < EPS && j < i);
      });
    });
  }

  // Free space in the packer's inflated coordinates -- callers take the
  // cutting spacing back off before showing it as material.
  largestFree(): Rect | null {
    let best: Rect | null = null;
    for (const f of this.free) {
      if (!best || f.w * f.h > best.w * best.h) best = f;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------

interface PartInstance {
  part: CutPart;
  instance: number;
}

interface PackedBin {
  bin: MaxRectsBin;
  placements: Placement[];
  partAreaMm2: number;
}

// A pack attempt: the plates it filled, and the pieces it could not fit
// because the plate count ran out. Leftovers are carried rather than thrown
// so a capped run still produces the layout for the plates it does have --
// "here are your 3 plates and the 2 pieces that need a 4th" is the answer,
// not an empty page.
interface PackAttempt {
  bins: PackedBin[];
  leftover: PartInstance[];
}

function packGroup(
  instances: PartInstance[],
  stock: StockPlate,
  spacing: number,
  edgeMargin: number,
  allowRotation: boolean,
  heuristic: FitHeuristic,
  maxBins: number | null
): PackAttempt | null {
  // Parts are inflated by one spacing and packed into a bin one spacing
  // larger than the usable area. That inflation lands exactly one spacing
  // between any two neighbours and exactly one edge margin at the plate
  // boundary, which is why the gaps in the drawn layout are the gaps the
  // torch will actually leave.
  const binW = stock.lengthMm - 2 * edgeMargin + spacing;
  const binH = stock.widthMm - 2 * edgeMargin + spacing;

  const bins: PackedBin[] = [];
  const leftover: PartInstance[] = [];

  for (const { part, instance } of instances) {
    const rotatable = allowRotation && part.rotatable;
    let placed: { target: PackedBin; rect: PlacedRect } | null = null;

    for (const b of bins) {
      const rect = b.bin.insert(part.lengthMm + spacing, part.widthMm + spacing, rotatable, heuristic);
      if (rect) {
        placed = { target: b, rect };
        break;
      }
    }
    if (!placed) {
      // Every open plate is full and the stock list says there is no next
      // plate. The piece is set aside rather than forced, and the caller
      // reports it -- silently overrunning the plate count would produce a
      // layout for metal nobody has.
      if (maxBins != null && bins.length >= maxBins) {
        leftover.push({ part, instance });
        continue;
      }
      const fresh: PackedBin = { bin: new MaxRectsBin(binW, binH), placements: [], partAreaMm2: 0 };
      const rect = fresh.bin.insert(part.lengthMm + spacing, part.widthMm + spacing, rotatable, heuristic);
      // Not even an empty plate takes it at this spacing. Losing the piece
      // quietly is the one outcome that must never happen, so the whole
      // attempt fails and the caller tries a tighter allowance.
      if (!rect) return null;
      bins.push(fresh);
      placed = { target: fresh, rect };
    }
    const { target, rect } = placed;

    target.placements.push({
      partId: part.id,
      partNo: part.partNo,
      shape: part.shape,
      instance,
      x: edgeMargin + rect.x,
      y: edgeMargin + rect.y,
      w: rect.w - spacing,
      h: rect.h - spacing,
      rotated: rect.rotated,
      outlinePath: part.outlinePath ?? null,
    });
    target.partAreaMm2 += part.lengthMm * part.widthMm;
  }

  return { bins, leftover };
}

function sortInstances(instances: PartInstance[], key: "area" | "max-side" | "width"): PartInstance[] {
  const scored = instances.map((it) => {
    const { lengthMm: l, widthMm: w } = it.part;
    return { it, score: key === "area" ? l * w : key === "max-side" ? Math.max(l, w) : w };
  });
  // Ties break on part number so the plan is stable between runs -- a layout
  // that reshuffles when nothing changed cannot be trusted or diffed.
  scored.sort((a, b) => b.score - a.score || a.it.part.partNo.localeCompare(b.it.part.partNo) || a.it.instance - b.it.instance);
  return scored.map((s) => s.it);
}

// Fewer plates is the whole objective -- plate is what gets bought. Between
// two attempts that buy the same number, the better one leaves the last plate
// emptiest, because that is the plate the remnant comes off and the one the
// next job can still draw on.
function isBetter(candidate: PackAttempt, incumbent: PackAttempt): boolean {
  // Cutting the job beats cutting it economically: an attempt that gets one
  // more piece onto the available plate wins even if it burns more of it.
  if (candidate.leftover.length !== incumbent.leftover.length) return candidate.leftover.length < incumbent.leftover.length;
  if (candidate.bins.length !== incumbent.bins.length) return candidate.bins.length < incumbent.bins.length;
  const lastArea = (a: PackAttempt) => a.bins[a.bins.length - 1]?.partAreaMm2 ?? 0;
  return lastArea(candidate) < lastArea(incumbent);
}

/**
 * Arranges every part onto as few plates of the given stock as the spacing
 * allows, and reports what would not fit and why.
 *
 * Parts are grouped by thickness and material first: a 10 mm gusset cannot be
 * cut from a 6 mm plate, and nesting across grades would produce a layout no
 * one can buy material for.
 */
export function nestParts(parts: CutPart[], stocks: StockPlate[], options: NestOptions = {}): NestResult {
  const allowRotation = options.allowRotation ?? true;

  const plates: NestedPlate[] = [];
  const unplaced: UnplacedPart[] = [];
  const allowancePlans: AllowancePlan[] = [];
  const assumedThicknessParts: string[] = [];
  const stockUsage: StockUsage[] = [];

  const groups = new Map<string, { thicknessMm: number; material: string; parts: CutPart[] }>();
  for (const part of parts) {
    if (part.quantity <= 0) continue;
    if (!(part.lengthMm > 0) || !(part.widthMm > 0)) {
      unplaced.push({ part, quantity: part.quantity, reason: "no cutting size read from the drawing" });
      continue;
    }
    // An unstated thickness is taken from the stock rather than treated as an
    // error: a cutting sheet plotted from model space routinely carries the
    // outline and nothing else, and the plate on the table is the answer.
    const thicknessMm = part.thicknessMm ?? stocks[0]?.thicknessMm ?? null;
    if (thicknessMm == null) {
      unplaced.push({ part, quantity: part.quantity, reason: "no plate thickness on the drawing and no stock defined to assume one from" });
      continue;
    }
    if (part.thicknessMm == null) assumedThicknessParts.push(part.partNo);

    const material = (part.material ?? "").trim().toLowerCase();
    const key = `${thicknessMm}|${material}`;
    const group = groups.get(key) ?? { thicknessMm, material, parts: [] };
    group.parts.push(part);
    groups.set(key, group);
  }

  for (const [, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Same thickness is the hard requirement. Matching the grade is preferred,
    // but a stock row left ungraded is usable for anything -- that is what an
    // unstated grade means on an input form.
    const matching = stocks.filter((s) => Math.abs(s.thicknessMm - group.thicknessMm) < EPS);
    const stock =
      matching.find((s) => (s.material ?? "").trim().toLowerCase() === group.material) ??
      matching.find((s) => !(s.material ?? "").trim()) ??
      matching[0];

    if (!stock) {
      for (const part of group.parts) {
        unplaced.push({ part, quantity: part.quantity, reason: `no ${group.thicknessMm} mm stock plate defined` });
      }
      continue;
    }

    // Allowances are derived from the thickness actually being cut, so a part
    // is only declared too big once it fails at the TIGHTEST safe margin --
    // screening it against the generous one would throw away a part the shop
    // can cut perfectly well.
    const minimum = minimumAllowances(stock.thicknessMm);
    const usableL = stock.lengthMm - 2 * minimum.edgeMarginMm;
    const usableW = stock.widthMm - 2 * minimum.edgeMarginMm;

    const instances: PartInstance[] = [];
    for (const part of group.parts) {
      const rotatable = allowRotation && part.rotatable;
      const fitsAsDrawn = part.lengthMm <= usableL + EPS && part.widthMm <= usableW + EPS;
      const fitsTurned = rotatable && part.widthMm <= usableL + EPS && part.lengthMm <= usableW + EPS;
      if (!fitsAsDrawn && !fitsTurned) {
        unplaced.push({
          part,
          quantity: part.quantity,
          reason:
            `${Math.round(part.lengthMm)} x ${Math.round(part.widthMm)} exceeds the ${Math.round(usableL)} x ${Math.round(usableW)} usable area of a ` +
            `${stock.lengthMm} x ${stock.widthMm} plate, even at the tightest safe edge margin of ${minimum.edgeMarginMm} mm` +
            (part.rotatable ? "" : ", and the drawing fixes its rolling direction so it cannot be turned"),
        });
        continue;
      }
      for (let i = 1; i <= part.quantity; i++) instances.push({ part, instance: i });
    }
    if (instances.length === 0) continue;

    // For each allowance on the ladder, nest properly -- one packer pass is a
    // guess, so the plausible orderings and fit rules are all run and the best
    // kept -- then take the FIRST allowance that reaches the lowest plate
    // count. The ladder runs most generous first, so that is the loosest
    // spacing the job can afford: everything looser costs a plate, everything
    // tighter gives up tolerance and buys nothing back.
    const ladder = allowanceCandidates(stock.thicknessMm);
    // How many plates of this size the job may open. A row with no count set
    // is unlimited, which answers "how much plate do I need?"; a row with one
    // answers "does it fit on what I have?".
    const maxBins = stock.quantity != null && Number.isFinite(stock.quantity) && stock.quantity > 0 ? Math.floor(stock.quantity) : null;
    const tried: Array<{ allowances: Allowances; attempt: PackAttempt }> = [];
    for (const allowances of ladder) {
      let best: PackAttempt | null = null;
      for (const sortKey of ["area", "max-side", "width"] as const) {
        const ordered = sortInstances(instances, sortKey);
        for (const heuristic of ["short-side", "long-side", "area"] as const) {
          const attempt = packGroup(ordered, stock, allowances.spacingMm, allowances.edgeMarginMm, allowRotation, heuristic, maxBins);
          if (attempt && (!best || isBetter(attempt, best))) best = attempt;
        }
      }
      if (best) tried.push({ allowances, attempt: best });
    }
    if (tried.length === 0) continue;

    // Fitting the job comes first, and only then fitting it on fewest plates.
    // Under a plate cap those pull in opposite directions: the tightest
    // spacing on the ladder is often the only one that gets everything onto
    // the plates available, and it is preferred exactly then.
    const fewestLeft = Math.min(...tried.map((t) => t.attempt.leftover.length));
    const viable = tried.filter((t) => t.attempt.leftover.length === fewestLeft);
    const fewest = Math.min(...viable.map((t) => t.attempt.bins.length));
    const chosen = viable.find((t) => t.attempt.bins.length === fewest)!;
    const tightest = tried[tried.length - 1];
    const generous = generousAllowances(stock.thicknessMm);
    const atMostGenerous = chosen.allowances.webMm >= generous.webMm && chosen.allowances.edgeMarginMm >= generous.edgeMarginMm;

    const basis =
      `${stock.thicknessMm} mm plate: a ${chosen.allowances.kerfMm} mm kerf is what the plasma nozzle for this thickness takes out. ` +
      (atMostGenerous
        ? `Web ${chosen.allowances.webMm} mm and edge margin ${chosen.allowances.edgeMarginMm} mm -- the most generous spacing worth running, and here it costs nothing: ` +
          `cutting back to the ${minimum.webMm} mm minimum would still need ${tightest.attempt.bins.length} plate${tightest.attempt.bins.length === 1 ? "" : "s"}.`
        : `Web ${chosen.allowances.webMm} mm and edge margin ${chosen.allowances.edgeMarginMm} mm -- tightened from the ${generous.webMm} mm web a shop would run given the room, ` +
          `because that spacing did not fit on ${chosen.attempt.bins.length} plate${chosen.attempt.bins.length === 1 ? "" : "s"}. Still clear of the ${minimum.webMm} mm minimum for ` +
          `${stock.thicknessMm} mm plate, so nothing is given up on tolerance.`);

    allowancePlans.push({
      thicknessMm: stock.thicknessMm,
      material: stock.material,
      allowances: chosen.allowances,
      minimum,
      plateCount: chosen.attempt.bins.length,
      atMostGenerous,
      plateCountAtMinimum: tightest.attempt.bins.length,
      basis,
    });

    for (const b of chosen.attempt.bins) {
      const plateAreaMm2 = stock.lengthMm * stock.widthMm;
      const free = b.bin.largestFree();
      const offcutL = free ? free.w - chosen.allowances.spacingMm : 0;
      const offcutW = free ? free.h - chosen.allowances.spacingMm : 0;
      plates.push({
        index: plates.length + 1,
        stockId: stock.id,
        lengthMm: stock.lengthMm,
        widthMm: stock.widthMm,
        thicknessMm: stock.thicknessMm,
        material: stock.material,
        allowances: chosen.allowances,
        placements: b.placements,
        partAreaMm2: b.partAreaMm2,
        plateAreaMm2,
        utilisation: plateAreaMm2 > 0 ? b.partAreaMm2 / plateAreaMm2 : 0,
        largestOffcut: offcutL > 0 && offcutW > 0 ? { lengthMm: Math.round(offcutL), widthMm: Math.round(offcutW) } : null,
      });
    }

    // Pieces the plate count would not stretch to. Reported per part with the
    // count that did not fit, so the answer is "order one more plate" or
    // "raise the limit", not a layout that silently drops work.
    if (chosen.attempt.leftover.length > 0) {
      const byPart = new Map<string, { part: CutPart; quantity: number }>();
      for (const { part } of chosen.attempt.leftover) {
        const entry = byPart.get(part.id) ?? { part, quantity: 0 };
        entry.quantity += 1;
        byPart.set(part.id, entry);
      }
      const limit = maxBins ?? 0;
      for (const entry of byPart.values()) {
        unplaced.push({
          part: entry.part,
          quantity: entry.quantity,
          reason:
            `the stock list allows ${limit} plate${limit === 1 ? "" : "s"} of ${stock.lengthMm} x ${stock.widthMm} x ${stock.thicknessMm} mm, ` +
            `and ${limit === 1 ? "that plate is" : "those are"} full at the tightest safe spacing -- this piece needs plate ${limit + 1}`,
        });
      }
    }

    const usedHere = chosen.attempt.bins.length;
    const seen = stockUsage.find((u) => u.stockId === stock.id);
    if (seen) {
      seen.used += usedHere;
      seen.short = seen.short || chosen.attempt.leftover.length > 0;
    } else {
      stockUsage.push({
        stockId: stock.id,
        lengthMm: stock.lengthMm,
        widthMm: stock.widthMm,
        thicknessMm: stock.thicknessMm,
        material: stock.material,
        available: maxBins,
        used: usedHere,
        short: chosen.attempt.leftover.length > 0,
      });
    }
  }

  const plateAreaMm2 = plates.reduce((sum, p) => sum + p.plateAreaMm2, 0);
  const partAreaMm2 = plates.reduce((sum, p) => sum + p.partAreaMm2, 0);
  const toM2 = (v: number) => v / 1_000_000;

  return {
    plates,
    unplaced,
    allowancePlans,
    assumedThicknessParts,
    stockUsage,
    totals: {
      plateCount: plates.length,
      plateCountAvailable: stockUsage.some((u) => u.available == null)
        ? null
        : stockUsage.reduce((sum, u) => sum + (u.available ?? 0), 0),
      plateAreaM2: toM2(plateAreaMm2),
      partAreaM2: toM2(partAreaMm2),
      wasteM2: toM2(plateAreaMm2 - partAreaMm2),
      utilisation: plateAreaMm2 > 0 ? partAreaMm2 / plateAreaMm2 : 0,
    },
  };
}
