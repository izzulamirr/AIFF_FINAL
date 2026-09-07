// True-shape nesting, across as many plates as the stock allows, presented as
// an ordinary NestResult.
//
// The bounding-box nester and the true-shape nester answer the same question
// with different fidelity, and everything downstream -- the plate drawing, the
// PDF, the DXF, the cut list -- should not have to care which one ran. So the
// true-shape result is converted into the same NestResult the box nester
// returns, with each placement's rotation BAKED INTO its outline path rather
// than carried as a flag: a box nester can only turn a part 90 degrees, this
// one turns it 30, and there is nowhere in a Placement to say so.

import {
  allowanceCandidates,
  generousAllowances,
  minimumAllowances,
  type Allowances,
  type CutPart,
  type NestResult,
  type NestedPlate,
  type Placement,
  type StockPlate,
  type UnplacedPart,
} from "./nesting";
import { nestTrueShape, type Ring, type TrueShapePart } from "./trueShapeNesting";

export interface TrueShapePlanOptions {
  allowRotation?: boolean;
  // Raster resolution. Finer packs better and costs roughly the square of it;
  // 8 mm is the working compromise on a 12 m plate.
  cellMm?: number;
  rotations?: number[];
}

function rotateRings(rings: Ring[], deg: number): Ring[] {
  if (!deg) return rings;
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const out = rings.map((r) => r.map(([x, y]) => [x * c - y * s, x * s + y * c] as [number, number]));
  let minX = Infinity;
  let minY = Infinity;
  for (const r of out) for (const [x, y] of r) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  return out.map((r) => r.map(([x, y]) => [x - minX, y - minY] as [number, number]));
}

const pathOf = (rings: Ring[]) =>
  rings.map((r) => "M" + r.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L") + "Z").join(" ");

/**
 * Nests the parts that carry real outlines onto the given stock, opening a new
 * plate only when the previous one will take no more and never more plates
 * than the stock row allows.
 */
export function nestTrueShapePlan(
  parts: CutPart[],
  stock: StockPlate,
  options: TrueShapePlanOptions = {}
): NestResult {
  // Caller picked the search: run exactly that.
  if (options.cellMm != null || options.rotations != null) return runPlan(parts, stock, options);

  // Otherwise: a fast pass first, and a wider one only if something did not
  // fit. On a real 21-piece job the fast pass places everything in about five
  // seconds; the wide pass costs ten more and is only ever paid when the fast
  // one has already failed to place a piece, which is exactly when it is worth
  // paying. Searching hard on a job that fits easily buys nothing.
  const allow = options.allowRotation ?? true;
  // 20 mm is an upper bound, not the cell used: the nester derives the real
  // cell from the spacing so the dilation lands exactly (see trueShapeNesting).
  // Asking for finer than this buys nothing here -- the clearance is exact
  // either way now -- and costs seven times the run time.
  const passes: TrueShapePlanOptions[] = allow
    ? [
        { ...options, cellMm: 20, rotations: [0, 90, 180, 270] },
        { ...options, cellMm: 20, rotations: [0, 45, 90, 135, 180, 225, 270, 315] },
      ]
    : [{ ...options, cellMm: 20, rotations: [0] }];

  let best: NestResult | null = null;
  for (const pass of passes) {
    const result = runPlan(parts, stock, pass);
    const unplaced = result.unplaced.reduce((sum, u) => sum + u.quantity, 0);
    if (unplaced === 0) return result;
    const bestUnplaced = best ? best.unplaced.reduce((sum, u) => sum + u.quantity, 0) : Infinity;
    if (!best || unplaced < bestUnplaced || (unplaced === bestUnplaced && result.totals.plateCount < best.totals.plateCount)) {
      best = result;
    }
  }
  return best!;
}

function runPlan(parts: CutPart[], stock: StockPlate, options: TrueShapePlanOptions): NestResult {
  const allowRotation = options.allowRotation ?? true;
  const cellMm = options.cellMm ?? 12;
  const rotations = options.rotations ?? (allowRotation ? [0, 90, 180, 270] : [0]);

  const usable = parts.filter((p) => p.quantity > 0 && p.outlineRings && p.outlineRings.length > 0);
  const unplaced: UnplacedPart[] = [];
  for (const part of parts) {
    if (!usable.includes(part) && part.quantity > 0) {
      unplaced.push({ part, quantity: part.quantity, reason: "no outline geometry -- this part came from a PDF, not from CAD" });
    }
  }
  if (usable.length === 0) {
    return {
      plates: [],
      unplaced,
      allowancePlans: [],
      assumedThicknessParts: [],
      stockUsage: [],
      totals: { plateCount: 0, plateCountAvailable: null, plateAreaM2: 0, partAreaM2: 0, wasteM2: 0, utilisation: 0 },
    };
  }

  const thicknessMm = stock.thicknessMm;
  const minimum = minimumAllowances(thicknessMm);
  const generous = generousAllowances(thicknessMm);
  const maxPlates = stock.quantity != null && stock.quantity > 0 ? Math.floor(stock.quantity) : 50;

  // Remaining quantity per part, decremented as plates fill.
  const remaining = new Map<string, number>();
  for (const part of usable) remaining.set(part.id, part.quantity);
  // Instance numbers continue across plates, so a cut list never shows two #1s.
  const nextInstance = new Map<string, number>();

  const plates: NestedPlate[] = [];
  let chosenAllowances: Allowances = generous;
  let tightened = false;

  for (let plateNo = 1; plateNo <= maxPlates; plateNo++) {
    const left = usable
      .map((part) => ({ part, quantity: remaining.get(part.id) ?? 0 }))
      .filter((entry) => entry.quantity > 0);
    if (left.length === 0) break;

    const shapeParts: TrueShapePart[] = left.map(({ part, quantity }) => ({
      id: part.id,
      partNo: part.partNo,
      quantity,
      rings: part.outlineRings as Ring[],
      widthMm: part.lengthMm,
      heightMm: part.widthMm,
      netAreaMm2: part.netAreaMm2 ?? part.lengthMm * part.widthMm,
      rotatable: allowRotation && part.rotatable,
    }));

    // The allowance ladder, same principle as the box nester: run the most
    // generous spacing that still fits, and tighten only when tightening is
    // what makes it fit at all.
    let best: { allowances: Allowances; nest: ReturnType<typeof nestTrueShape> } | null = null;
    for (const allowances of allowanceCandidates(thicknessMm)) {
      const nest = nestTrueShape(
        shapeParts,
        { lengthMm: stock.lengthMm, widthMm: stock.widthMm },
        allowances,
        { cellMm, rotations }
      );
      if (!best || nest.placements.length > best.nest.placements.length) best = { allowances, nest };
      // Everything left fits at this spacing -- no reason to look tighter.
      if (nest.placements.length === shapeParts.reduce((sum, p) => sum + p.quantity, 0)) break;
    }
    if (!best || best.nest.placements.length === 0) break;

    chosenAllowances = best.allowances;
    if (best.allowances.webMm < generous.webMm) tightened = true;

    const placements: Placement[] = [];
    let partAreaMm2 = 0;
    for (const placed of best.nest.placements) {
      const part = usable.find((p) => p.id === placed.partId)!;
      const instance = (nextInstance.get(part.id) ?? 0) + 1;
      nextInstance.set(part.id, instance);
      remaining.set(part.id, (remaining.get(part.id) ?? 0) - 1);
      const rings = rotateRings(part.outlineRings as Ring[], placed.rotationDeg);
      const info = part.outlineRingInfo ?? [];
      placements.push({
        outlineLoops: rings.map((points, k) => ({
          points,
          closed: info[k]?.closed !== false,
          hole: info[k]?.hole === true,
        })),
        partId: part.id,
        partNo: part.partNo,
        shape: part.shape,
        instance,
        x: placed.xMm,
        y: placed.yMm,
        w: placed.wMm,
        h: placed.hMm,
        // The turn is already in the path, so nothing downstream may turn it
        // again. This is why the flag is false even for a part at 120 degrees.
        rotated: false,
        rotationDeg: placed.rotationDeg,
        outlinePath: pathOf(rings),
      });
      partAreaMm2 += part.netAreaMm2 ?? placed.wMm * placed.hMm;
    }

    const plateAreaMm2 = stock.lengthMm * stock.widthMm;
    const usedTo = Math.max(...placements.map((p) => p.x + p.w));
    plates.push({
      index: plates.length + 1,
      stockId: stock.id,
      lengthMm: stock.lengthMm,
      widthMm: stock.widthMm,
      thicknessMm: stock.thicknessMm,
      material: stock.material,
      allowances: best.allowances,
      placements,
      partAreaMm2,
      plateAreaMm2,
      utilisation: plateAreaMm2 > 0 ? partAreaMm2 / plateAreaMm2 : 0,
      // Here the remnant IS a located strip: the true-shape nester packs from
      // one end, so everything past the last part is whole plate.
      largestOffcut:
        stock.lengthMm - usedTo > 50 ? { lengthMm: Math.round(stock.lengthMm - usedTo), widthMm: stock.widthMm } : null,
    });
  }

  for (const part of usable) {
    const left = remaining.get(part.id) ?? 0;
    if (left > 0) {
      unplaced.push({
        part,
        quantity: left,
        reason:
          `the stock list allows ${maxPlates} plate${maxPlates === 1 ? "" : "s"} of ${stock.lengthMm} x ${stock.widthMm} x ` +
          `${stock.thicknessMm} mm and this piece needs another one`,
      });
    }
  }

  const plateAreaMm2 = plates.reduce((sum, p) => sum + p.plateAreaMm2, 0);
  const partAreaMm2 = plates.reduce((sum, p) => sum + p.partAreaMm2, 0);
  const toM2 = (v: number) => v / 1_000_000;

  return {
    plates,
    unplaced,
    allowancePlans: plates.length
      ? [
          {
            thicknessMm,
            material: stock.material,
            allowances: chosenAllowances,
            minimum,
            plateCount: plates.length,
            atMostGenerous: !tightened,
            plateCountAtMinimum: plates.length,
            basis:
              `${thicknessMm} mm plate: a ${chosenAllowances.kerfMm} mm kerf is what the plasma nozzle for this thickness takes out. ` +
              `Web ${chosenAllowances.webMm} mm and edge margin ${chosenAllowances.edgeMarginMm} mm` +
              (tightened
                ? `, tightened from the ${generous.webMm} mm web a shop would run given the room, because that spacing did not fit. ` +
                  `Still clear of the ${minimum.webMm} mm minimum, so nothing is given up on tolerance.`
                : ` -- the most generous spacing worth running, and it fits.`) +
              ` Nested on the true outlines at ${cellMm} mm resolution, so parts sit inside each other's concave regions.`,
          },
        ]
      : [],
    assumedThicknessParts: usable.filter((p) => p.thicknessMm == null).map((p) => p.partNo),
    stockUsage: plates.length
      ? [
          {
            stockId: stock.id,
            lengthMm: stock.lengthMm,
            widthMm: stock.widthMm,
            thicknessMm: stock.thicknessMm,
            material: stock.material,
            available: stock.quantity != null && stock.quantity > 0 ? Math.floor(stock.quantity) : null,
            used: plates.length,
            short: unplaced.length > 0,
          },
        ]
      : [],
    totals: {
      plateCount: plates.length,
      plateCountAvailable: stock.quantity != null && stock.quantity > 0 ? Math.floor(stock.quantity) : null,
      plateAreaM2: toM2(plateAreaMm2),
      partAreaM2: toM2(partAreaMm2),
      wasteM2: toM2(plateAreaMm2 - partAreaMm2),
      utilisation: plateAreaMm2 > 0 ? partAreaMm2 / plateAreaMm2 : 0,
    },
  };
}
