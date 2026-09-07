// True-shape plate nesting.
//
// The box nester (nesting.ts) reserves each part's bounding rectangle, which
// on these profiles is half air: a gusset with a pipe radius bitten out of it
// pays for metal it never touches, and nothing can be put in the bite. This
// nests the OUTLINE instead, so one part sits inside another's concavity and
// the plate stops being bought to hold empty space.
//
// The method is raster, not no-fit-polygon. Each part is burned into a
// bitmask at a fixed cell size and placement is a bitwise overlap test. NFP
// is exact and faster asymptotically, but it is delicate around holes,
// self-touching outlines and near-degenerate edges -- all of which real CAD
// profiles have -- whereas a raster mask cannot produce an invalid overlap,
// only a slightly conservative one. On a cutting plan, conservative in the
// direction of MORE clearance is the safe error: the parts come out the right
// size, the plan is just fractionally less dense than theoretical.
//
// The cutting allowance is applied by DILATING each mask by half the
// part-to-part spacing before placement. Two dilated masks that merely touch
// therefore leave exactly one spacing between the real edges, so the kerf and
// the web survive in the layout without any per-pair distance arithmetic.

import type { Allowances } from "./nesting";

export type Ring = Array<[number, number]>;

export interface TrueShapePart {
  id: string;
  partNo: string;
  quantity: number;
  // Every closed loop of the outline. Rasterised as a UNION, so overlapping
  // loops (a boss drawn over the body it stands on) merge rather than cancel.
  rings: Ring[];
  widthMm: number;
  heightMm: number;
  netAreaMm2: number;
  rotatable: boolean;
}

export interface TrueShapePlacement {
  partId: string;
  partNo: string;
  instance: number;
  xMm: number; // of the rotated part's bounding box, from the plate's left edge
  yMm: number; // from the plate's top edge
  rotationDeg: number;
  wMm: number; // bounding box AFTER rotation
  hMm: number;
}

export interface TrueShapeResult {
  placements: TrueShapePlacement[];
  unplaced: Array<{ partNo: string; quantity: number; reason: string }>;
  placedAreaMm2: number;
  plateAreaMm2: number;
  utilisation: number;
  cellMm: number;
  rotationsTried: number[];
}

// ---------------------------------------------------------------------------
// Bit-packed raster mask. Rows of 32-bit words so an overlap test is a handful
// of ANDs rather than a loop over cells.
// ---------------------------------------------------------------------------

interface Mask {
  w: number; // cells
  h: number;
  words: number; // words per row
  bits: Uint32Array;
  // Bounding box of the UNDILATED shape within the mask, in cells. Placement
  // is constrained on this, not on the dilated envelope, so the edge margin
  // applies to the real part.
  padCells: number;
}

function rotateRings(rings: Ring[], deg: number): Ring[] {
  if (deg === 0) return rings;
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const rotated = rings.map((r) => r.map(([x, y]) => [x * c - y * s, x * s + y * c] as [number, number]));
  let minX = Infinity, minY = Infinity;
  for (const r of rotated) for (const [x, y] of r) { if (x < minX) minX = x; if (y < minY) minY = y; }
  return rotated.map((r) => r.map(([x, y]) => [x - minX, y - minY] as [number, number]));
}

function ringsExtent(rings: Ring[]) {
  let maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) { if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  return { w: maxX, h: maxY };
}

// Scanline fill, one ring at a time, OR-ed together -- a UNION, not even-odd
// across the whole part.
//
// This distinction is not cosmetic. A part's outline routinely arrives as
// overlapping loops: a circular boss drawn as a full circle on top of the body
// it sits proud of. Even-odd would XOR their overlap AWAY, punching a phantom
// hole through the middle of solid metal, and the nester would then place
// another part inside it. Union cannot do that.
//
// Real holes are left FILLED here on purpose. A hole is a legitimate place to
// nest a small part, but only with the shop's say-so, and a plan that quietly
// buries one part inside another's bolt hole is a plan nobody trusts. Filling
// them costs a little density and removes the surprise.
// Sample lines per raster row. Four bounds the vertical coverage error at an
// eighth of a cell; the cost lands only on mask construction, which happens
// once per part and rotation.
const SUBSAMPLES = 4;

function rasterize(rings: Ring[], cellMm: number, padCells: number): Mask {
  const ext = ringsExtent(rings);
  const w = Math.ceil(ext.w / cellMm) + 1 + padCells * 2;
  const h = Math.ceil(ext.h / cellMm) + 1 + padCells * 2;
  const words = Math.ceil(w / 32);
  const bits = new Uint32Array(words * h);

  const xs: number[] = [];
  for (const ring of rings) {
    const edges: Array<[number, number, number, number]> = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
    }
    if (edges.length === 0) continue;
    for (let row = 0; row < h; row++) {
      // Several sample lines per row, unioned.
      //
      // One sample at the row's centre is what a rasteriser normally does, and
      // it UNDER-covers: a slanted edge crossing the row between the sample and
      // the row boundary leaves the cell clear, so the mask is smaller than the
      // part. Every millimetre of that comes straight out of the cutting gap --
      // two under-covered parts placed against each other measured 32 mm where
      // 36 was required. Sampling the row's top, bottom and middle bounds the
      // error at an eighth of a cell instead of a half, and the cost is paid
      // once per part and rotation rather than per placement tried.
      for (let sub = 0; sub < SUBSAMPLES; sub++) {
        const y = (row - padCells + (sub + 0.5) / SUBSAMPLES) * cellMm;
        xs.length = 0;
        for (const [x1, y1, x2, y2] of edges) {
          if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.floor(xs[k] / cellMm) + padCells);
          const c1 = Math.min(w - 1, Math.ceil(xs[k + 1] / cellMm) + padCells);
          for (let c = c0; c <= c1; c++) bits[row * words + (c >> 5)] |= 1 << (c & 31);
        }
      }
    }

    // ...and then the boundary itself, walked cell by cell.
    //
    // Scanline filling can only ever be as good as its samples, and a mask
    // that is a hair SMALLER than the part silently spends that hair out of
    // the cutting gap. Walking every edge through the grid guarantees the mask
    // is a superset of the outline: no cell the boundary passes through can be
    // left clear, whatever the sampling did. That turns "accurate to an eighth
    // of a cell" into "never under-covers", which is the property the
    // allowance actually needs.
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      markSegment(bits, words, w, h, cellMm, padCells, a[0], a[1], b[0], b[1]);
    }
  }
  return { w, h, words, bits, padCells };
}

// Every cell a segment passes through, by grid traversal -- not by sampling
// points along it, which can step over a cell the line only clips.
function markSegment(
  bits: Uint32Array,
  words: number,
  w: number,
  h: number,
  cellMm: number,
  padCells: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  const ax = x1 / cellMm + padCells;
  const ay = y1 / cellMm + padCells;
  const bx = x2 / cellMm + padCells;
  const by = y2 / cellMm + padCells;
  let cx = Math.floor(ax);
  let cy = Math.floor(ay);
  const ex = Math.floor(bx);
  const ey = Math.floor(by);
  const dx = bx - ax;
  const dy = by - ay;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx !== 0 ? (stepX > 0 ? cx + 1 - ax : ax - cx) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (stepY > 0 ? cy + 1 - ay : ay - cy) * tDeltaY : Infinity;

  const set = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) bits[y * words + (x >> 5)] |= 1 << (x & 31);
  };

  set(cx, cy);
  // Bounded so a degenerate segment cannot spin: the longest possible walk is
  // the grid's own diagonal.
  let guard = w + h + 4;
  while ((cx !== ex || cy !== ey) && guard-- > 0) {
    if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      cx += stepX;
    } else {
      tMaxY += tDeltaY;
      cy += stepY;
    }
    set(cx, cy);
  }
}

// Square dilation, separable: a horizontal pass then a vertical one. Square
// rather than circular overshoots the clearance slightly at corners, which is
// the safe direction.
function dilate(mask: Mask, r: number): Mask {
  if (r <= 0) return mask;
  const { w, h, words } = mask;
  const get = (bits: Uint32Array, x: number, y: number) => (bits[y * words + (x >> 5)] >>> (x & 31)) & 1;
  const set = (bits: Uint32Array, x: number, y: number) => { bits[y * words + (x >> 5)] |= 1 << (x & 31); };

  const horiz = new Uint32Array(words * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!get(mask.bits, x, y)) continue;
      const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
      for (let k = lo; k <= hi; k++) set(horiz, k, y);
    }
  }
  const out = new Uint32Array(words * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!get(horiz, x, y)) continue;
      const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
      for (let k = lo; k <= hi; k++) set(out, x, k);
    }
  }
  return { ...mask, bits: out };
}

// Occupancy of the plate, as bit rows.
class Plate {
  readonly words: number;
  readonly bits: Uint32Array;
  constructor(readonly w: number, readonly h: number) {
    this.words = Math.ceil(w / 32);
    this.bits = new Uint32Array(this.words * h);
  }

  // Shifted-word overlap test. The mask is bit-packed from its own origin, so
  // placing it at an arbitrary x means straddling word boundaries -- hence the
  // two-word shift rather than a per-cell loop.
  fits(mask: Mask, ox: number, oy: number): boolean {
    const shift = ox & 31;
    const wordOff = ox >> 5;
    for (let my = 0; my < mask.h; my++) {
      const py = oy + my;
      if (py < 0 || py >= this.h) {
        for (let mw = 0; mw < mask.words; mw++) if (mask.bits[my * mask.words + mw]) return false;
        continue;
      }
      const base = py * this.words;
      for (let mw = 0; mw < mask.words; mw++) {
        const word = mask.bits[my * mask.words + mw];
        if (!word) continue;
        const lo = (word << shift) >>> 0;
        const hi = shift === 0 ? 0 : (word >>> (32 - shift)) >>> 0;
        const i0 = base + wordOff + mw;
        if (lo) {
          if (wordOff + mw < 0 || wordOff + mw >= this.words) return false;
          if ((this.bits[i0] & lo) !== 0) return false;
        }
        if (hi) {
          if (wordOff + mw + 1 >= this.words) return false;
          if ((this.bits[i0 + 1] & hi) !== 0) return false;
        }
      }
    }
    return true;
  }

  stamp(mask: Mask, ox: number, oy: number) {
    const shift = ox & 31;
    const wordOff = ox >> 5;
    for (let my = 0; my < mask.h; my++) {
      const py = oy + my;
      if (py < 0 || py >= this.h) continue;
      const base = py * this.words;
      for (let mw = 0; mw < mask.words; mw++) {
        const word = mask.bits[my * mask.words + mw];
        if (!word) continue;
        const lo = (word << shift) >>> 0;
        const hi = shift === 0 ? 0 : (word >>> (32 - shift)) >>> 0;
        const i0 = base + wordOff + mw;
        if (lo && i0 >= base && i0 < base + this.words) this.bits[i0] |= lo;
        if (hi && i0 + 1 < base + this.words) this.bits[i0 + 1] |= hi;
      }
    }
  }
}

export interface TrueShapeOptions {
  cellMm?: number;
  rotations?: number[];
  allowRotation?: boolean;
}

/**
 * Nests every part onto ONE plate by its true outline, packing toward the
 * bottom-left, and reports anything that would not fit.
 *
 * Placement is bottom-left-fill: for each candidate rotation the lowest
 * feasible position is taken, ties broken to the left. Large parts go first --
 * a big profile placed late has nowhere to go, while a small one late slots
 * into a gap, which is exactly the asymmetry that makes this beat the box
 * nester on a mixed sheet.
 */
function attempt(
  parts: TrueShapePart[],
  plate: { lengthMm: number; widthMm: number },
  allowances: Allowances,
  options: TrueShapeOptions,
  order: OrderKey,
  packAcross: boolean
): TrueShapeResult {
  const allowRotation = options.allowRotation ?? true;
  const rotations = options.rotations ?? [0, 90, 180, 270];

  const edge = allowances.edgeMarginMm;
  const halfSpacing = allowances.spacingMm / 2;

  // The cell size is DERIVED from the spacing, not taken as given.
  //
  // Dilation happens in whole cells, so a cell size that does not divide the
  // half-spacing quantises it -- and rounding to the nearest cell rounds DOWN
  // half the time. On 50 mm plate that meant a 17 mm half-gap becoming one
  // 12 mm cell and a nest that delivered 24 mm of web where 34 was required:
  // every piece cut undersized by the difference, on a plan that reported the
  // right number. Rounding up instead would be safe but wasteful, spending up
  // to a whole cell of plate on every gap.
  //
  // So the requested cell size is treated as an UPPER BOUND and the actual one
  // is the largest that divides the half-spacing exactly. The dilation is then
  // exactly half a spacing, by construction, at a resolution at least as fine
  // as asked for.
  const requestedCellMm = options.cellMm ?? 20;
  const padCells = Math.max(1, Math.ceil(halfSpacing / requestedCellMm));
  const cellMm = halfSpacing / padCells;

  const plateW = Math.floor(plate.lengthMm / cellMm);
  const plateH = Math.floor(plate.widthMm / cellMm);
  const occ = new Plate(plateW, plateH);

  // The edge margin is enforced by blocking a border of the occupancy grid, so
  // the ordinary collision test covers it and no placement needs a separate
  // boundary check.
  //
  // The mask already carries half a spacing of dilation all round, and that
  // padding is for the NEIGHBOURING PART, not for the plate edge. Blocking the
  // full edge margin on top of it would hold every part edge + halfSpacing
  // from the rolled edge -- 43 mm rather than 25 on 50 mm plate -- which is
  // enough to push a part that genuinely fits off the plate entirely. So the
  // border blocked here is only the part of the margin the dilation does not
  // already provide.
  //
  // Rounded UP, unlike the dilation, because the leftover here does not divide
  // evenly and the rolled edge is the one place where being short is not
  // recoverable -- the plate simply is not metal out there.
  const edgeCells = Math.max(0, Math.ceil((edge - halfSpacing) / cellMm - 1e-9));
  for (let y = 0; y < plateH; y++) {
    for (let x = 0; x < plateW; x++) {
      if (x < edgeCells || y < edgeCells || x >= plateW - edgeCells || y >= plateH - edgeCells) {
        occ.bits[y * occ.words + (x >> 5)] |= 1 << (x & 31);
      }
    }
  }

  // One entry per piece, biggest first.
  const queue: Array<{ part: TrueShapePart; instance: number }> = [];
  for (const p of parts) for (let i = 1; i <= p.quantity; i++) queue.push({ part: p, instance: i });
  const score = (p: TrueShapePart) => {
    switch (order) {
      case "area": return p.netAreaMm2;
      case "box": return p.widthMm * p.heightMm;
      case "long-side": return Math.max(p.widthMm, p.heightMm);
      case "short-side": return Math.min(p.widthMm, p.heightMm);
    }
  };
  // Ties break on part number so a plan never reshuffles between runs.
  queue.sort(
    (a, b) => score(b.part) - score(a.part) || a.part.partNo.localeCompare(b.part.partNo) || a.instance - b.instance
  );

  // Masks are cut once per (part, rotation) and reused for every instance.
  const maskCache = new Map<string, { mask: Mask; wMm: number; hMm: number }>();
  const maskFor = (part: TrueShapePart, deg: number) => {
    const key = `${part.id}@${deg}`;
    let hit = maskCache.get(key);
    if (!hit) {
      const rings = rotateRings(part.rings, deg);
      const ext = ringsExtent(rings);
      hit = { mask: dilate(rasterize(rings, cellMm, padCells), padCells), wMm: ext.w, hMm: ext.h };
      maskCache.set(key, hit);
    }
    return hit;
  };

  const placements: TrueShapePlacement[] = [];
  const unplaced: TrueShapeResult["unplaced"] = [];
  let placedArea = 0;

  for (const { part, instance } of queue) {
    const angles = allowRotation && part.rotatable ? rotations : [0];
    let best: { x: number; y: number; deg: number; wMm: number; hMm: number } | null = null;

    for (const deg of angles) {
      const { mask, wMm, hMm } = maskFor(part, deg);
      if (mask.w > plateW || mask.h > plateH) continue;
      for (let x = 0; x + mask.w <= plateW; x++) {
        for (let y = 0; y + mask.h <= plateH; y++) {
          if (!occ.fits(mask, x, y)) continue;
          // Which axis is packed against first decides the whole character of
          // the layout. On a long plate (12 m x 3 m) filling column by column
          // from one end keeps a clean unused remnant at the far end, which is
          // worth more to a shop than the same area scattered as slivers; on a
          // squarer plate packing to the bottom is denser. So the primary axis
          // follows the plate's own proportions.
          const better = packAcross
            ? !best || x < best.x || (x === best.x && y < best.y)
            : !best || y < best.y || (y === best.y && x < best.x);
          if (better) best = { x, y, deg, wMm, hMm };
          break; // first fit in this column is its lowest
        }
      }
    }

    if (!best) {
      const existing = unplaced.find((u) => u.partNo === part.partNo);
      if (existing) existing.quantity++;
      else unplaced.push({ partNo: part.partNo, quantity: 1, reason: "no room left on the plate at any tried rotation" });
      continue;
    }

    const { mask } = maskFor(part, best.deg);
    occ.stamp(mask, best.x, best.y);
    placements.push({
      partId: part.id,
      partNo: part.partNo,
      instance,
      // The mask carries padCells of dilation around the real outline, so the
      // part itself starts one pad in from where the mask was stamped.
      xMm: +((best.x + mask.padCells) * cellMm).toFixed(1),
      yMm: +((best.y + mask.padCells) * cellMm).toFixed(1),
      rotationDeg: best.deg,
      wMm: +best.wMm.toFixed(1),
      hMm: +best.hMm.toFixed(1),
    });
    placedArea += part.netAreaMm2;
  }

  const plateAreaMm2 = plate.lengthMm * plate.widthMm;
  return {
    placements,
    unplaced,
    placedAreaMm2: placedArea,
    plateAreaMm2,
    utilisation: placedArea / plateAreaMm2,
    cellMm,
    rotationsTried: rotations,
  };
}


type OrderKey = "area" | "box" | "long-side" | "short-side";

// A single greedy pass is a guess: which part goes down first decides what
// room is left for everything after it, and no one ordering wins on every
// sheet. The orderings and both pack directions are cheap enough to run in
// full, so they are, and the best result is kept.
//
// Better means: most pieces placed first -- a plan that leaves a part off is
// not a plan -- then the shortest run along the plate, because the metal left
// unused in one piece at the far end is a remnant the shop can put back on the
// rack, while the same area scattered between parts is drop.
export function nestTrueShape(
  parts: TrueShapePart[],
  plate: { lengthMm: number; widthMm: number },
  allowances: Allowances,
  options: TrueShapeOptions = {}
): TrueShapeResult {
  const orders: OrderKey[] = ["area", "box", "long-side", "short-side"];
  const across = plate.lengthMm > plate.widthMm * 1.5 ? [true, false] : [false, true];

  const extent = (r: TrueShapeResult, wide: boolean) =>
    r.placements.length === 0
      ? 0
      : Math.max(...r.placements.map((p) => (wide ? p.xMm + p.wMm : p.yMm + p.hMm)));

  let best: TrueShapeResult | null = null;
  let bestExtent = Infinity;
  for (const order of orders) {
    for (const packAcross of across) {
      const r = attempt(parts, plate, allowances, options, order, packAcross);
      const e = extent(r, plate.lengthMm >= plate.widthMm);
      if (!best || r.placements.length > best.placements.length || (r.placements.length === best.placements.length && e < bestExtent)) {
        best = r;
        bestExtent = e;
      }
    }
  }
  return best!;
}
