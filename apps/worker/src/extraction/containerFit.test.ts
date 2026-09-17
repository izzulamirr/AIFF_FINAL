import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSpoolFit,
  fitsContainer,
  shippingEnvelope,
  STANDARD_CONTAINERS,
  FIELD_WELD_ALLOWANCE_MM,
  type ContainerSpec,
} from "@easy/shared";

const box = (lengthMm: number, widthMm: number, heightMm: number) => ({ lengthMm, widthMm, heightMm });
const spec = (name: string) => STANDARD_CONTAINERS.find((c) => c.name === name)!;
const named = (f: { container: string }[]) => f.map((r) => r.container);

/* --- turning the spool ---------------------------------------------------- */

test("a spool is turned to fit -- which side was called length does not matter", () => {
  // Too tall as given, fine on its side.
  const upright = box(600, 800, 5000);
  const r = fitsContainer(upright, spec("20ft GP"));
  assert.equal(r.fits, true);
  assert.equal(r.orientation?.[0], 5000, "the long side goes down the container");
});

test("the same three sides give the same answer however they are ordered", () => {
  const answers = [box(5000, 800, 600), box(800, 5000, 600), box(600, 800, 5000)].map(
    (e) => fitsContainer(e, spec("20ft GP")).fits
  );
  assert.deepEqual(answers, [true, true, true]);
});

/* --- the door ------------------------------------------------------------- */

test("a spool can fit the SPACE and still not pass the door", () => {
  // 2,350 wide clears the 2,352 internal but not the 2,340 door opening.
  const wide = box(4000, 2350, 1000);
  const gp = fitsContainer(wide, spec("20ft GP"));
  assert.equal(gp.fits, false);
  assert.match(gp.blockedBy.join(" "), /door/);
});

test("a top-loaded container has no door to pass", () => {
  const wide = box(4000, 2350, 1000);
  assert.equal(fitsContainer(wide, spec("20ft open top")).fits, true);
});

/* --- the field weld allowance --------------------------------------------- */

test("a field weld adds its 150mm of excess pipe to what gets shipped", () => {
  const e = box(5000, 400, 400);
  assert.deepEqual(shippingEnvelope(e, { fieldWelds: 1 }), box(5000 + FIELD_WELD_ALLOWANCE_MM, 400, 400));
});

test("with no field weld nothing is added", () => {
  const e = box(5000, 400, 400);
  assert.deepEqual(shippingEnvelope(e, { fieldWelds: 0 }), e);
});

test("two field welds take two allowances", () => {
  assert.equal(shippingEnvelope(box(5000, 400, 400), { fieldWelds: 2 }).lengthMm, 5300);
});

test("the allowance goes on the named axis when the joint's axis is known", () => {
  const e = box(5000, 400, 400);
  assert.deepEqual(shippingEnvelope(e, { fieldWelds: 1, axis: "height" }), box(5000, 400, 550));
});

test("with no axis known it goes on the LONGEST side -- the worst case", () => {
  // Worst case because the longest side is what runs out of container first.
  const e = box(400, 5000, 400);
  assert.equal(shippingEnvelope(e, { fieldWelds: 1 }).widthMm, 5150);
});

test("the allowance can be what pushes a spool out of a 20ft LOADED SQUARE", () => {
  const e = box(5800, 500, 500);
  assert.equal(checkSpoolFit("N-x", e).smallestStraight?.container, "20ft GP");
  const withFw = checkSpoolFit("N-x", e, { fieldWelds: 1 });
  assert.equal(withFw.shipping.lengthMm, 5950);
  assert.equal(withFw.smallestStraight?.container, "40ft GP", "5,950mm no longer clears a 20ft's 5,898mm end to end");
  // ...but it still goes in a 20ft on the diagonal, which is the whole point
  // of checking: the answer is a choice, not a size.
  assert.equal(withFw.smallest?.container, "20ft GP");
  assert.equal(withFw.smallest?.how, "angled");
});

/* --- choosing a container ------------------------------------------------- */

test("the smallest container that takes it is the answer", () => {
  const r = checkSpoolFit("N-01", box(1000, 700, 700));
  assert.equal(r.smallest?.container, "20ft GP");
  assert.ok(named(r.results.filter((x) => x.fits)).includes("40ft GP"), "the bigger ones still fit");
});

test("a spool too long for anything fits nothing, and says which side is over", () => {
  const r = checkSpoolFit("N-x", box(14000, 500, 500));
  assert.equal(r.smallest, null);
  assert.ok(r.results.every((x) => !x.fits));
  assert.match(r.results[0].blockedBy.join(" "), /longest side 14000mm over/);
});

test("a spool the 20ft door will not take is still offered a top-loaded box", () => {
  // 2,350 x 2,340 clears the 20ft internal section but neither way round does
  // it pass its 2,340 x 2,280 door. Dropped in from above it is fine.
  const r = checkSpoolFit("N-x", box(5000, 2350, 2340));
  const by = (n: string) => r.results.find((x) => x.container === n)!;
  assert.equal(by("20ft GP").fits, false);
  assert.match(by("20ft GP").blockedBy.join(" "), /door/);
  assert.equal(by("20ft open top").fits, true);
});

/* --- how close is too close ----------------------------------------------- */

test("a fit within 50mm is flagged marginal -- real containers vary", () => {
  const r = checkSpoolFit("N-x", box(5880, 500, 500));
  assert.equal(r.smallest?.container, "20ft GP");
  assert.equal(r.marginal, true, "18mm of clearance is not a yes");
});

test("a comfortable fit is not flagged", () => {
  assert.equal(checkSpoolFit("N-x", box(3000, 800, 800)).marginal, false);
});

test("tightestMm reports the closest gap, door included", () => {
  const r = fitsContainer(box(5000, 2330, 1000), spec("20ft GP"));
  assert.equal(r.fits, true);
  assert.equal(r.tightestMm, 10, "2,340 door less 2,330 wide");
});

/* --- caller's own containers ---------------------------------------------- */

test("a caller can supply their own container list", () => {
  const truck: ContainerSpec = { name: "flatbed", internal: { lengthMm: 13000, widthMm: 2500, heightMm: 3000 } };
  const r = checkSpoolFit("N-x", box(12500, 2400, 2900), { containers: [truck] });
  assert.equal(r.smallest?.container, "flatbed");
});

/* --- angling it across the floor ------------------------------------------ */

test("a spool LONGER than the container still goes in on the diagonal", () => {
  // A 20ft is 5,898mm end to end but 6,350mm corner to corner, so a 6m spool
  // of small section fits -- swung round. This is the case a plain
  // length comparison gets wrong.
  const r = fitsContainer(box(6000, 219, 219), spec("20ft GP"));
  assert.equal(r.fits, true);
  assert.equal(r.how, "angled");
  assert.ok(r.angleDeg! > 0 && r.angleDeg! < 45, `expected a modest swing, got ${r.angleDeg}`);
});

test("CROSS-SECTION decides how much turning it takes, not length", () => {
  // Same 6,150mm length. At 219mm section it can be swung flat on the floor;
  // at 404mm it sweeps too wide for that and has to come up off the floor
  // as well. Both fit -- one is a much easier load than the other.
  assert.equal(fitsContainer(box(6150, 219, 219), spec("20ft GP")).how, "angled");
  assert.equal(fitsContainer(box(6150, 404, 404), spec("20ft GP")).how, "tilted");
});

test("the angle chosen is the one with the MOST room, not the least swing", () => {
  // The shallowest angle that works is by definition touching the end wall.
  const r = fitsContainer(box(6150, 219, 219), spec("20ft GP"));
  assert.ok(r.tightestMm! >= 40, `a usable angle should leave real clearance, got ${r.tightestMm}mm`);
});

test("square is always preferred where square works", () => {
  const r = fitsContainer(box(3000, 500, 500), spec("20ft GP"));
  assert.equal(r.how, "straight");
  assert.equal(r.angleDeg, 0);
});

test("past the floor diagonal a flat swing is not enough, so it tilts", () => {
  const r = fitsContainer(box(6400, 219, 219), spec("20ft GP"));
  assert.equal(r.fits, true);
  assert.equal(r.how, "tilted");
});

test("a section too fat to tilt is told which limit beat it", () => {
  // 6,500mm is inside the 6,786mm body diagonal, so length alone did not
  // defeat this one -- the 900mm section did.
  const r = fitsContainer(box(6500, 900, 900), spec("20ft GP"));
  assert.equal(r.fits, false);
  assert.match(r.blockedBy.join(" "), /section is too big to tilt/);
});

test("a spool that only fits angled reports what loading it square would cost", () => {
  const r = checkSpoolFit("N-12", box(6000, 219, 219));
  assert.equal(r.smallest?.container, "20ft GP");
  assert.equal(r.smallest?.how, "angled");
  assert.equal(r.smallestStraight?.container, "40ft GP");
});

test("angling never gets a spool past a door it cannot enter", () => {
  // It has to go IN before it can be turned.
  const r = fitsContainer(box(5000, 2350, 2340), spec("20ft GP"));
  assert.equal(r.fits, false);
  assert.match(r.blockedBy.join(" "), /door/);
});

/* --- turning it in all three axes ----------------------------------------- */

test("past the FLOOR diagonal it can still be tilted into the body diagonal", () => {
  // A 20ft: 5,898 end to end, 6,350 across the floor, 6,786 corner to corner.
  const r = fitsContainer(box(6500, 200, 200), spec("20ft GP"));
  assert.equal(r.fits, true);
  assert.equal(r.how, "tilted");
  assert.ok(r.tilt!.pitchDeg > 0, "it has to come off the floor to reach that");
});

test("past the BODY diagonal nothing fits, and it says which limit was hit", () => {
  const r = fitsContainer(box(6900, 200, 200), spec("20ft GP"));
  assert.equal(r.fits, false);
  assert.match(r.blockedBy.join(" "), /body diagonal -- no attitude fits/);
});

test("the easiest attitude that works is the one reported", () => {
  // Straight beats angled beats tilted: each is more rigging than the last.
  assert.equal(fitsContainer(box(3000, 400, 400), spec("20ft GP")).how, "straight");
  assert.equal(fitsContainer(box(6000, 219, 219), spec("20ft GP")).how, "angled");
  assert.equal(fitsContainer(box(6500, 200, 200), spec("20ft GP")).how, "tilted");
});

test("tilting still cannot get a spool through a door it will not enter", () => {
  const r = fitsContainer(box(5000, 2350, 2340), spec("20ft GP"));
  assert.equal(r.fits, false);
  assert.match(r.blockedBy.join(" "), /door/);
});

test("a fat spool gains nothing from tilting -- the section is the limit", () => {
  const r = fitsContainer(box(6500, 900, 900), spec("20ft GP"));
  assert.equal(r.fits, false);
});
