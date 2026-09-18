import test from "node:test";
import assert from "node:assert/strict";
import {
  chainLegs,
  fitsContainer,
  nominalBoreOdMm,
  shapeExtent,
  STANDARD_CONTAINERS,
  withFieldWeldAllowance,
  type LegInput,
} from "@easy/shared";

const spec = (name: string) => STANDARD_CONTAINERS.find((c) => c.name === name)!;

/**
 * A leg, given the page points its dimension attaches to. Those points are
 * what chains the run: the page positions say which legs meet, the read
 * millimetres say how long each one is, and the two are independent -- the
 * drawing is not to scale, so the page can only ever supply the joining.
 */
const leg = (cell: string, mm: number, direction: LegInput["direction"], from: [number, number], to: [number, number]): LegInput => ({
  cell,
  mm,
  direction,
  from: { x: from[0], y: from[1] },
  to: { x: to[0], y: to[1] },
});

/* --- chaining the legs ---------------------------------------------------- */

test("legs that join end to end chain into one run, in order", () => {
  // N-02 of the reference ISO, and the shape the user read off the drawing:
  // it goes DOWN, then EAST, then SOUTH, with east the MIDDLE part.
  const shape = chainLegs([
    leg("1-5", 1500, "S", [624, 407], [676, 437]),
    leg("1-9", 1412, "DOWN", [343, 443], [343, 569]),
    leg("1-23", 1500, "E", [343, 568], [429, 519]),
    leg("1-7", 881, "S", [676, 437], [782, 498]),
    leg("1-17", 937, "E", [515, 470], [624, 407]),
    leg("1-19", 1000, "E", [429, 519], [515, 470]),
  ]);
  assert.ok(shape, "these legs do chain");
  assert.deepEqual(
    shape!.legs.map((l) => `${l.direction} ${l.mm}`),
    ["DOWN 1412", "E 1500", "E 1000", "E 937", "S 1500", "S 881"]
  );
});

test("the chain is independent of the order the legs arrive in", () => {
  const legs = [
    leg("a", 100, "E", [0, 0], [10, 0]),
    leg("b", 200, "N", [10, 0], [10, 10]),
    leg("c", 300, "UP", [10, 10], [20, 10]),
  ];
  const forward = chainLegs(legs)!;
  const reversed = chainLegs([...legs].reverse())!;
  // Walked from the other end, so the order reverses -- the SHAPE is the same,
  // which is all the container cares about.
  assert.deepEqual(shapeExtent(forward), shapeExtent(reversed));
});

test("a BRANCH forks the walk, and a fork is refused rather than half-taken", () => {
  // Three legs meeting at one point: the run plus a takeoff. Picking an arm
  // would silently drop the other, and the dropped arm is real pipe.
  assert.equal(
    chainLegs([
      leg("a", 100, "E", [0, 0], [10, 0]),
      leg("b", 200, "N", [10, 0], [10, 10]),
      leg("c", 300, "S", [10, 0], [10, -10]),
    ]),
    null
  );
});

test("legs that do not touch are not a run", () => {
  assert.equal(
    chainLegs([leg("a", 100, "E", [0, 0], [10, 0]), leg("b", 200, "N", [500, 500], [500, 510])]),
    null
  );
});

/* --- what the shape is worth ---------------------------------------------- */

test("the extent of a run that doubles back is MEASURED, not bounded", () => {
  // 754 east then 2795 west reaches 2795, not 3549 -- and unlike axisExtent's
  // bound, this knows it rather than assuming the worst order.
  const shape = chainLegs([
    leg("a", 754, "E", [0, 0], [10, 0]),
    leg("b", 5580, "UP", [10, 0], [10, 10]),
    leg("c", 2795, "W", [10, 10], [0, 10]),
  ])!;
  assert.equal(shapeExtent(shape).ewMm, 2795);
  assert.equal(shapeExtent(shape).upDownMm, 5580);
});

test("a field weld's excess is pipe left on the END of the run", () => {
  const shape = chainLegs([leg("a", 1000, "E", [0, 0], [10, 0])])!;
  assert.equal(shapeExtent(withFieldWeldAllowance(shape, 150)).ewMm, 1150);
  assert.equal(shapeExtent(withFieldWeldAllowance(shape, 0)).ewMm, 1000, "no field weld, no excess");
});

test("the bore is not the outside diameter, and an unknown bore is not guessed", () => {
  assert.equal(nominalBoreOdMm("200"), 219.1);
  assert.equal(nominalBoreOdMm("15"), 21.3);
  assert.equal(nominalBoreOdMm("7"), null, "off the standard table -- say so, do not invent");
  assert.equal(nominalBoreOdMm(undefined), null);
});

/* --- fitting the run instead of the box ----------------------------------- */

test("a run fits where its BOUNDING BOX does not, because the legs are at different ends", () => {
  // N-02 again: DOWN 1412, EAST 3437, SOUTH 2381. The box's cross-section is
  // 1412 x 2381, a shape the spool has nowhere -- one leg is at each END of
  // the 3437. As a box it will not pass a 20ft door; as a run it goes in.
  const points: Array<[number, number, number]> = [
    [0, 0, 0],
    [0, 0, -1412],
    [3437, 0, -1412],
    [3437, -2381, -1412],
  ];
  const asBox = fitsContainer({ lengthMm: 1412, widthMm: 2381, heightMm: 3437 }, spec("20ft GP"));
  const asRun = fitsContainer({ lengthMm: 1412, widthMm: 2381, heightMm: 3437 }, spec("20ft GP"), { points, odMm: 219.1 });
  assert.equal(asBox.fits, false, "the box is what used to be checked");
  assert.equal(asRun.fits, true, "the run is the spool");
});

test("the run still has to carry its own pipe -- the OD is not free", () => {
  const points: Array<[number, number, number]> = [
    [0, 0, 0],
    [5000, 0, 0],
  ];
  const thin = fitsContainer({ lengthMm: 5000, widthMm: 0, heightMm: 0 }, spec("20ft GP"), { points, odMm: 219.1 });
  const fat = fitsContainer({ lengthMm: 5000, widthMm: 0, heightMm: 0 }, spec("20ft GP"), { points, odMm: 2500 });
  assert.equal(thin.fits, true);
  assert.equal(fat.fits, false, "2500mm of pipe does not go in a 2352mm box");
});

test("a run is never reported as fitting somewhere its own extents do not", () => {
  // Sanity in the safe direction: a straight member longer than the body
  // diagonal fits nothing, run or box.
  const points: Array<[number, number, number]> = [
    [0, 0, 0],
    [9000, 0, 0],
  ];
  assert.equal(fitsContainer({ lengthMm: 9000, widthMm: 0, heightMm: 0 }, spec("20ft GP"), { points, odMm: 219.1 }).fits, false);
});
