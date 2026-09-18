import test from "node:test";
import assert from "node:assert/strict";
import { buildSpoolEnvelopes, outermost, placeDimension, type DimensionInput } from "@easy/shared";

type XY = [number, number];

/**
 * A dimension as the worker hands it over: the drawn line, plus where it was
 * found to ATTACH to the pipe. `attach` defaults to the drawn line itself
 * with full pipe coverage, which is the ordinary case.
 */
const dim = (
  cell: string,
  mm: number,
  from: XY,
  to: XY,
  attach?: { from: XY; to: XY; coverage?: number } | null
): DimensionInput & { mm: number } => {
  const deg = ((Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI + 360) % 180;
  return {
    cell,
    page: 1,
    from: { x: from[0], y: from[1] },
    to: { x: to[0], y: to[1] },
    mm,
    degrees: deg,
    witnessDegrees: 30,
    attach:
      attach === null
        ? null
        : {
            from: { x: (attach?.from ?? from)[0], y: (attach?.from ?? from)[1] },
            to: { x: (attach?.to ?? to)[0], y: (attach?.to ?? to)[1] },
            coverage: attach?.coverage ?? 1,
          },
  };
};

const ONE_WELD = [{ page: 1, weldNo: 1, mark: { x: 100, y: 200 } }];
const ONE_SPOOL = [{ page: 1, weldNo: 1, spool: "N-01" }];

test("an OVERALL dimension hides the parts nested inside it", () => {
  // Sheet 4 carries a 15109 spanning a 6000; adding both counts pipe twice.
  // These are ATTACH spans, not drawn lines -- on the real sheet 4 the overall
  // and both its parts attach at exactly x=695.5, because they are all on the
  // one piece of pipe.
  const all = [dim("a", 15109, [100, 100], [100, 500]), dim("b", 6000, [100, 200], [100, 350])];
  assert.deepEqual(outermost(all).map((k) => k.mm), [15109]);
});

test("a whole still hides its part when the two attach a few points apart", () => {
  // Rounding, not a different pipe.
  const all = [dim("a", 15109, [100, 100], [100, 500]), dim("b", 6000, [104, 200], [104, 350])];
  assert.deepEqual(outermost(all).map((k) => k.mm), [15109]);
});

test("dimensions that do NOT overlap are all kept", () => {
  const all = [dim("a", 200, [100, 100], [100, 200]), dim("b", 300, [100, 260], [100, 400])];
  assert.equal(outermost(all).length, 2);
});

test("SAME AXIS IS NOT THE SAME PIPE -- two parallel legs both survive", () => {
  // This is the one that went wrong. A span is projected onto its own
  // direction, so two legs running parallel at different places on the sheet
  // collapse onto the same interval and the shorter looks nested in the
  // longer. N-03 drops 2376 down the leg at x=782 and 506 down a separate leg
  // at x=1007; the 506 disappeared into the 2376 and 506mm of spool went
  // missing from the shipping envelope. Containment needs ONE LINE, not one
  // axis.
  const all = [dim("a", 2376, [782, 498], [782, 671]), dim("b", 506, [1007, 541], [1007, 651])];
  assert.deepEqual(outermost(all).map((k) => k.mm).sort((x, y) => y - x), [2376, 506]);
});

test("a dimension is grouped under the spool of the weld it attaches to", () => {
  const d = dim("1-1", 404, [60, 150], [60, 250], { from: [100, 160], to: [100, 240] });
  const { envelopes } = buildSpoolEnvelopes([d], ONE_WELD, ONE_SPOOL);
  const [env] = envelopes;
  assert.equal(env.spool, "N-01");
  assert.equal(env.upDownMm, 404);
  assert.deepEqual(env.parts["UP-DOWN"].map((p) => ({ cell: p.cell, mm: p.mm })), [{ cell: "1-1", mm: 404 }]);
  assert.equal(env.parts["UP-DOWN"][0].weldNo, 1, "the weld it was matched to, so a bad grouping is visible");
  assert.equal(env.parts["UP-DOWN"][0].drawnAs, "DOWN", "drawn top to bottom");
});

test("every total carries the dimensions that made it, so it can be argued with", () => {
  const dims = [
    dim("1-1", 202, [60, 150], [60, 210], { from: [100, 180], to: [100, 210] }),
    dim("1-2", 202, [60, 230], [60, 290], { from: [100, 210], to: [100, 240] }),
  ];
  const { envelopes } = buildSpoolEnvelopes(dims, ONE_WELD, ONE_SPOOL);
  assert.equal(envelopes[0].upDownMm, 404);
  assert.deepEqual(envelopes[0].parts["UP-DOWN"].map((p) => p.cell), ["1-1", "1-2"]);
});

test("an unread length contributes nothing", () => {
  const blank = { ...dim("1-1", 0, [60, 150], [60, 250]), mm: null };
  assert.deepEqual(buildSpoolEnvelopes([blank], ONE_WELD, ONE_SPOOL).envelopes, []);
});

test("a dimension that never reached the pipe cannot be placed", () => {
  const { envelopes, unplaced } = buildSpoolEnvelopes([dim("1-1", 404, [60, 150], [60, 250], null)], ONE_WELD, ONE_SPOOL);
  assert.deepEqual(envelopes, []);
  assert.deepEqual(unplaced.map((u) => u.why), ["no pipe"]);
});

test("a weld with no spool drops out rather than inventing one", () => {
  const d = dim("1-1", 404, [60, 150], [60, 250], { from: [100, 160], to: [100, 240] });
  assert.deepEqual(buildSpoolEnvelopes([d], ONE_WELD, []).envelopes, []);
});

// --- what makes a length part of a SPOOL ---------------------------------

test("a length spanning a bolted joint is no part of any spool", () => {
  // A valve bolted in between two flanges ships on its own, so a dimension
  // across one brackets no pipe -- the 464mm valve assemblies of the
  // reference ISO, which recur on four sheets and are rejected every time.
  const across = dim("1-6", 464, [60, 150], [60, 250], { from: [100, 160], to: [100, 240], coverage: 0 });
  const { envelopes, unplaced } = buildSpoolEnvelopes([across], ONE_WELD, ONE_SPOOL);
  assert.deepEqual(envelopes, []);
  assert.deepEqual(unplaced, [{ cell: "1-6", page: 1, mm: 464, why: "no pipe" }]);
});

test("part-covered still counts: an elbow interrupts the run without ending it", () => {
  // Sheet 1's 184mm branch drop measures 46% -- the elbow is drawn on its
  // own two short axes. Pipe that bends is still pipe.
  const bent = dim("1-8", 184, [60, 150], [60, 250], { from: [100, 160], to: [100, 240], coverage: 0.46 });
  const { envelopes } = buildSpoolEnvelopes([bent], ONE_WELD, ONE_SPOOL);
  assert.equal(envelopes[0].upDownMm, 184);
});

test("a length whose ends sit in two spools belongs wholly to neither", () => {
  const welds = [
    { page: 1, weldNo: 2, mark: { x: 100, y: 150 } },
    { page: 1, weldNo: 9, mark: { x: 100, y: 250 } },
  ];
  const assignment = [
    { page: 1, weldNo: 2, spool: "N-01" },
    { page: 1, weldNo: 9, spool: "N-03" },
  ];
  const d = dim("1-x", 900, [60, 150], [60, 250], { from: [100, 150], to: [100, 250] });
  const { envelopes, unplaced } = buildSpoolEnvelopes([d], welds, assignment);
  assert.deepEqual(envelopes, []);
  assert.equal(unplaced[0].why, "spans N-01|N-03");
});

test("but CONSECUTIVE welds either side of a cut give the pipe to the later spool", () => {
  // A field weld closes the spool it ends, so the piece after it starts the
  // next one -- sheet 4's 6000mm run between its two FW ticks.
  const welds = [
    { page: 1, weldNo: 6, mark: { x: 100, y: 150 } },
    { page: 1, weldNo: 7, mark: { x: 100, y: 250 } },
  ];
  const assignment = [
    { page: 1, weldNo: 6, spool: "N-12" },
    { page: 1, weldNo: 7, spool: "N-13" },
  ];
  const d = dim("4-6", 6000, [60, 150], [60, 250], { from: [100, 150], to: [100, 250] });
  const { envelopes } = buildSpoolEnvelopes([d], welds, assignment);
  assert.equal(envelopes[0].spool, "N-13");
  assert.equal(envelopes[0].upDownMm, 6000);
});

test("one firm end is enough when the other reaches no weld at all", () => {
  // The run's own end, or a weld whose leader could not be traced -- sheet 1
  // has two, and its 202mm to weld 5 is one of them.
  const d = dim("1-2", 202, [60, 150], [60, 250], { from: [100, 600], to: [100, 205] });
  const { envelopes } = buildSpoolEnvelopes([d], ONE_WELD, ONE_SPOOL);
  assert.equal(envelopes[0].upDownMm, 202);
});

test("a lone end that is not firm is refused rather than guessed at", () => {
  const d = dim("1-x", 202, [60, 150], [60, 250], { from: [100, 600], to: [100, 245] });
  const { envelopes, unplaced } = buildSpoolEnvelopes([d], ONE_WELD, ONE_SPOOL);
  assert.deepEqual(envelopes, []);
  assert.equal(unplaced[0].why, "no weld");
});

test("placeDimension says WHY, so a miss is never silent", () => {
  const spoolOf = () => "N-01";
  assert.deepEqual(placeDimension(dim("a", 1, [0, 0], [0, 10], null), ONE_WELD, spoolOf), { why: "no pipe" });
  assert.deepEqual(
    placeDimension(dim("a", 1, [0, 0], [0, 10], { from: [0, 0], to: [0, 10], coverage: 0 }), ONE_WELD, spoolOf),
    { why: "no pipe" }
  );
  assert.deepEqual(placeDimension(dim("a", 1, [900, 900], [900, 910]), ONE_WELD, spoolOf), { why: "no weld" });
});

test("the direction a dimension is DRAWN in is recorded, both ways round", () => {
  const down = buildSpoolEnvelopes([dim("a", 100, [60, 150], [60, 250], { from: [100, 160], to: [100, 240] })], ONE_WELD, ONE_SPOOL);
  const up = buildSpoolEnvelopes([dim("b", 100, [60, 250], [60, 150], { from: [100, 240], to: [100, 160] })], ONE_WELD, ONE_SPOOL);
  assert.equal(down.envelopes[0].parts["UP-DOWN"][0].drawnAs, "DOWN");
  assert.equal(up.envelopes[0].parts["UP-DOWN"][0].drawnAs, "UP");
  // Same extent either way -- which is why drawn direction must NOT be read
  // as the pipe doubling back.
  assert.equal(down.envelopes[0].upDownMm, up.envelopes[0].upDownMm);
});

// --- a length must not count pipe past the end of its own spool ----------

test("a length running PAST the spool's boundary weld is flagged", () => {
  // Sheet 1's 1186: from the elbow, past the field weld at weld 12, on to
  // the end of the next piece. 305mm of it is the next spool's.
  const welds = [
    { page: 1, weldNo: 11, mark: { x: 100, y: 100 } },
    { page: 1, weldNo: 12, mark: { x: 100, y: 180 } },
    { page: 1, weldNo: 13, mark: { x: 100, y: 260 } },
  ];
  const assignment = [
    { page: 1, weldNo: 11, spool: "N-02" },
    { page: 1, weldNo: 12, spool: "N-02" },
    { page: 1, weldNo: 13, spool: "N-03" },
  ];
  const past = dim("1-7", 1186, [60, 100], [60, 200], { from: [100, 100], to: [100, 200] });
  const { envelopes } = buildSpoolEnvelopes([past], welds, assignment);
  const part = envelopes[0].parts["UP-DOWN"][0];
  assert.equal(part.overshootWeldNo, 12, "names the boundary weld it runs past");
  assert.equal(part.overshootPt, 20, "in POINTS -- the mm cannot be scaled off a drawing that is not to scale");
});

test("a length ENDING at the boundary weld is not an overshoot", () => {
  const welds = [
    { page: 1, weldNo: 11, mark: { x: 100, y: 100 } },
    { page: 1, weldNo: 12, mark: { x: 100, y: 200 } },
    { page: 1, weldNo: 13, mark: { x: 100, y: 300 } },
  ];
  const assignment = [
    { page: 1, weldNo: 11, spool: "N-02" },
    { page: 1, weldNo: 12, spool: "N-02" },
    { page: 1, weldNo: 13, spool: "N-03" },
  ];
  const ends = dim("1-x", 900, [60, 100], [60, 200], { from: [100, 100], to: [100, 200] });
  const { envelopes } = buildSpoolEnvelopes([ends], welds, assignment);
  assert.equal(envelopes[0].parts["UP-DOWN"][0].overshootPt, undefined);
});

test("an INTERIOR weld inside the span is not a boundary and not an overshoot", () => {
  // Every dimension spanning two welds contains welds; only a weld where the
  // spool CHANGES means the length has left the spool.
  const welds = [
    { page: 1, weldNo: 1, mark: { x: 100, y: 100 } },
    { page: 1, weldNo: 2, mark: { x: 100, y: 150 } },
    { page: 1, weldNo: 3, mark: { x: 100, y: 200 } },
  ];
  const assignment = [1, 2, 3].map((weldNo) => ({ page: 1, weldNo, spool: "N-02" }));
  const over = dim("1-y", 900, [60, 100], [60, 200], { from: [100, 100], to: [100, 200] });
  const { envelopes } = buildSpoolEnvelopes([over], welds, assignment);
  assert.equal(envelopes[0].parts["UP-DOWN"][0].overshootPt, undefined);
});

test("a corrected length is not ALSO flagged -- the correction is the answer", () => {
  const welds = [
    { page: 1, weldNo: 11, mark: { x: 100, y: 100 } },
    { page: 1, weldNo: 12, mark: { x: 100, y: 180 } },
    { page: 1, weldNo: 13, mark: { x: 100, y: 260 } },
  ];
  const assignment = [
    { page: 1, weldNo: 11, spool: "N-02" },
    { page: 1, weldNo: 12, spool: "N-02" },
    { page: 1, weldNo: 13, spool: "N-03" },
  ];
  const fixed = {
    ...dim("1-7", 881, [60, 100], [60, 200], { from: [100, 100], to: [100, 200] }),
    printedMm: 1186,
    correctionWhy: "the printed 1186 runs 305mm past the field weld",
  };
  const part = buildSpoolEnvelopes([fixed], welds, assignment).envelopes[0].parts["UP-DOWN"][0];
  assert.equal(part.mm, 881);
  assert.equal(part.printedMm, 1186);
  assert.equal(part.overshootPt, undefined, "already accounted for");
});

test("a SMALL run past a weld is the ordinary case, not an overshoot", () => {
  // A dimension ends at the fitting, not at the weld dot a few points inside
  // it. N-01's verified 588 depends on its 202 running 7pt past weld 6 and
  // not being docked for it.
  const welds = [
    { page: 1, weldNo: 5, mark: { x: 100, y: 100 } },
    { page: 1, weldNo: 6, mark: { x: 100, y: 193 } },
    { page: 1, weldNo: 7, mark: { x: 100, y: 280 } },
  ];
  const assignment = [
    { page: 1, weldNo: 5, spool: "N-01" },
    { page: 1, weldNo: 6, spool: "N-01" },
    { page: 1, weldNo: 7, spool: "N-02" },
  ];
  const d = dim("1-4", 202, [60, 100], [60, 200], { from: [100, 100], to: [100, 200] });
  const part = buildSpoolEnvelopes([d], welds, assignment).envelopes[0].parts["UP-DOWN"][0];
  assert.equal(part.overshootPt, undefined, "7pt past the weld is the fitting, not the next spool");
  assert.equal(part.mm, 202);
});

test("an overshoot the sheet dimensions separately is SUBTRACTED, not added", () => {
  // Sheet 1: the 1186 runs from the elbow past the field weld at weld 12,
  // and the 305 beside it measures exactly the part beyond. Both attach at
  // the same far end. The spool's share is 1186 - 305.
  const welds = [
    { page: 1, weldNo: 11, mark: { x: 100, y: 100 } },
    { page: 1, weldNo: 12, mark: { x: 100, y: 180 } },
    { page: 1, weldNo: 13, mark: { x: 100, y: 260 } },
  ];
  const assignment = [
    { page: 1, weldNo: 11, spool: "N-02" },
    { page: 1, weldNo: 12, spool: "N-02" },
    { page: 1, weldNo: 13, spool: "N-03" },
  ];
  const run = dim("1-7", 1186, [60, 100], [60, 200], { from: [100, 100], to: [100, 200] });
  const tail = dim("1-13", 305, [60, 180], [60, 200], { from: [100, 180], to: [100, 200] });
  const { envelopes } = buildSpoolEnvelopes([run, tail], welds, assignment);
  const parts = envelopes[0].parts["UP-DOWN"];
  assert.equal(envelopes[0].upDownMm, 881, "1186 - 305");
  assert.equal(parts.length, 1, "the tail is consumed, not listed as well");
  assert.equal(parts[0].printedMm, 1186, "what the sheet prints is kept beside it");
  assert.match(parts[0].correctionWhy ?? "", /305mm beyond/);
});

test("an OVERALL containing its parts is still dropped, not subtracted", () => {
  // The parts sit in the MIDDLE of the overall and share no end with it, and
  // the overall does not overshoot anything -- sheet 4's 15109 over a 6000.
  const welds = [
    { page: 1, weldNo: 1, mark: { x: 100, y: 100 } },
    { page: 1, weldNo: 2, mark: { x: 100, y: 400 } },
  ];
  const assignment = [1, 2].map((weldNo) => ({ page: 1, weldNo, spool: "N-12" }));
  const overall = dim("a", 15109, [60, 100], [60, 400], { from: [100, 100], to: [100, 400] });
  const part = dim("b", 6000, [70, 180], [70, 300], { from: [100, 180], to: [100, 300] });
  const { envelopes } = buildSpoolEnvelopes([overall, part], welds, assignment);
  assert.equal(envelopes[0].upDownMm, 15109, "the overall stands; the part inside it is dropped");
});

// ---------------------------------------------------------------------------
// WHICH WAY A LEG RUNS
//
// The direction is the order CAD wrote the dimension's two endpoints. That
// sounds like it should be arbitrary, and an override was built on that
// assumption -- orienting the run graph outward from the end a flow arrow
// points away from, and naming each leg by the pipe under it. Measured across
// both drawings: 48 legs agreed with the drawn order, 24 differed, and the
// differences came in whole components (every horizontal on page 2, every one
// on page 5, the two branch legs on page 1). That is a fragment rooted
// backwards, not a bad endpoint order -- the run graph is built from the
// heaviest line weight and leaves a sheet in disconnected pieces, and a piece
// with no flow arrow in it has nothing to root it but a guess.
//
// Every case that could be checked against the drawing went to the drawn
// order, so it stands. These pin the cases that were checked.

const leg = (cell: string, mm: number, x: number, yFrom: number, yTo: number) => ({
  cell,
  page: 1,
  from: { x, y: yFrom },
  to: { x, y: yTo },
  mm,
  degrees: 90,
  witnessDegrees: 30,
  attach: { from: { x, y: Math.min(yFrom, yTo) }, to: { x, y: Math.max(yFrom, yTo) }, coverage: 0.9 },
});

const ONE = [{ page: 1, weldNo: 1, mark: { x: 100, y: 200 } }];
const ONE_S = [{ page: 1, weldNo: 1, spool: "N-01" }];

test("a leg drawn top to bottom is a DROP", () => {
  // N-03's 2376 main leg, and page 2's 506 vent branch hanging below the run.
  const { envelopes } = buildSpoolEnvelopes([leg("1-16", 2376, 100, 150, 250)], ONE, ONE_S);
  assert.equal(envelopes[0].parts["UP-DOWN"][0].drawnAs, "DOWN");
});

test("a leg drawn bottom to top is a RISE", () => {
  // N-03's two weldolet branches, 385 each. The run override called these DOWN
  // because the main run drops where they rise; the drawing says otherwise.
  const { envelopes } = buildSpoolEnvelopes([leg("1-20", 385, 100, 250, 150)], ONE, ONE_S);
  assert.equal(envelopes[0].parts["UP-DOWN"][0].drawnAs, "UP");
});

test("one spool can do BOTH, and both are reported", () => {
  // N-03 drops 2376 + 506 down two separate legs and rises 385 up each of two
  // branches: DOWN 2882 and UP 770, never a single "UP-DOWN 3652".
  const welds = [1, 2, 3, 4].map((weldNo) => ({ page: 1, weldNo, mark: { x: weldNo * 100, y: 200 } }));
  const assignment = welds.map((w) => ({ page: 1, weldNo: w.weldNo, spool: "N-03" }));
  const dims = [
    leg("1-16", 2376, 100, 150, 250),
    leg("1-18", 506, 200, 150, 250),
    leg("1-20", 385, 300, 250, 150),
    leg("1-21", 385, 400, 250, 150),
  ];
  const { envelopes } = buildSpoolEnvelopes(dims, welds, assignment);
  const by: Record<string, number> = {};
  for (const p of envelopes[0].parts["UP-DOWN"]) by[p.drawnAs] = (by[p.drawnAs] ?? 0) + p.mm;
  assert.deepEqual(by, { DOWN: 2882, UP: 770 });
});

// ---------------------------------------------------------------------------
// NO PIPE UNDER THE SPAN: a bolted valve, or a welded fitting?
//
// The coverage test exists because a valve is bolted in between two flanges
// and ships on its own, so a length across one is no part of any spool. But a
// REDUCING TEE or a reducer interrupts the drawn line just as completely and
// is a FABRICATION item -- welded in, shipped with the spool. Both read 0%
// coverage, so coverage cannot tell them apart.
//
// The BORE does: a reducer is where the line changes size. Sheet 2 carries
// both, 30pt apart -- its 241mm spans welds 14 and 15 at 200 and 150 (the
// reducing tee), its 273mm spans welds 15 and 16 at 150 and 150 (the gate
// valve in the reduced section).

const bare = (cell: string, mm: number, from: XY, to: XY) => dim(cell, mm, from, to, { from, to, coverage: 0 });

test("a length across a REDUCER is welded in, so the spool keeps it", () => {
  const welds = [
    { page: 1, weldNo: 14, mark: { x: 100, y: 100 }, size: "200" },
    { page: 1, weldNo: 15, mark: { x: 100, y: 200 }, size: "150" },
  ];
  const assignment = welds.map((w) => ({ page: 1, weldNo: w.weldNo, spool: "N-06" }));
  const { envelopes } = buildSpoolEnvelopes([bare("2-11", 241, [100, 100], [100, 200])], welds, assignment);
  assert.equal(envelopes[0]?.spool, "N-06");
  assert.equal(envelopes[0]?.upDownMm, 241);
});

test("a length across a VALVE is bolted in, and still drops out", () => {
  // Same shape, same nil coverage -- only the bores differ.
  const welds = [
    { page: 1, weldNo: 15, mark: { x: 100, y: 100 }, size: "150" },
    { page: 1, weldNo: 16, mark: { x: 100, y: 200 }, size: "150" },
  ];
  const assignment = welds.map((w) => ({ page: 1, weldNo: w.weldNo, spool: "N-06" }));
  const { envelopes, unplaced } = buildSpoolEnvelopes([bare("2-9", 273, [100, 100], [100, 200])], welds, assignment);
  assert.deepEqual(envelopes, []);
  assert.equal(unplaced[0].why, "no pipe");
});

test("with no bores read, nil coverage still means no pipe", () => {
  // The weld list is the only source of a bore; without it the old answer
  // stands rather than every valve assembly being let in.
  const welds = [
    { page: 1, weldNo: 1, mark: { x: 100, y: 100 } },
    { page: 1, weldNo: 2, mark: { x: 100, y: 200 } },
  ];
  const assignment = welds.map((w) => ({ page: 1, weldNo: w.weldNo, spool: "N-01" }));
  const { unplaced } = buildSpoolEnvelopes([bare("1-1", 464, [100, 100], [100, 200])], welds, assignment);
  assert.equal(unplaced[0].why, "no pipe");
});

test("the reducer's welds must be AT the span, not further up the run", () => {
  // Sheet 2's 89mm has its 150/200 pair 3 and 36pt away. Sheet 1's 108mm,
  // which must stay out, has its nearest weld 107pt off and the next 135 --
  // welds elsewhere on the run whose differing bores would fake a size change.
  const far = [
    { page: 1, weldNo: 19, mark: { x: 100, y: -10 }, size: "200" },
    { page: 1, weldNo: 20, mark: { x: 100, y: -140 }, size: "15" },
  ];
  const assignment = far.map((w) => ({ page: 1, weldNo: w.weldNo, spool: "N-03" }));
  const { envelopes, unplaced } = buildSpoolEnvelopes([bare("1-25", 108, [100, 100], [100, 150])], far, assignment);
  assert.deepEqual(envelopes, []);
  assert.equal(unplaced[0].why, "no pipe");
});
