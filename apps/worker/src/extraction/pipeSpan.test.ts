import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSpan,
  configurationsFromDirections,
  findSpanStandard,
  materialFamily,
  npsInchOf,
  scheduleOf,
  PROCESS_AREA_SPANS,
  type SpanStandard,
} from "@easy/shared";

const CS8: Parameters<typeof checkSpan>[0]["npsInch"] extends never ? never : { npsInch: number; schedule: string; material: string } = {
  npsInch: 8,
  schedule: "20",
  material: "carbon steel",
};

/* --- choosing the sheet --------------------------------------------------- */

test("the ISO prints DN and the span sheet is headed NPS", () => {
  assert.equal(npsInchOf("200"), 8);
  assert.equal(npsInchOf("200 mm"), 8);
  assert.equal(npsInchOf('8"'), 8);
  assert.equal(npsInchOf("15"), 0.5);
  assert.equal(npsInchOf('1/2"'), 0.5);
  assert.equal(npsInchOf("7"), null, "off the standard table -- say so, do not invent");
  assert.equal(npsInchOf(undefined), null);
});

test("the material family is what spans, not the grade", () => {
  assert.equal(materialFamily("PIPE BE SMLS ASME B36.10, A106 GR B, SCH20"), "carbon steel");
  assert.equal(materialFamily("PIPE A312 TP316L"), "stainless steel");
  // The BODY is what sags; a stainless trim inside a carbon steel valve does
  // not make the run stainless.
  assert.equal(materialFamily("A216 WCB BODY, SS316L + HF TRIM"), "carbon steel");
  assert.equal(materialFamily("GASKET, SPIRAL WD"), null);
});

test("the schedule is read off the row that states it", () => {
  assert.equal(scheduleOf("PIPE BE SMLS, A106 GR B, SCH20"), "20");
  assert.equal(scheduleOf("SCH 160"), "160");
  assert.equal(scheduleOf("PIPE A106"), null);
});

test("a size, schedule or material the sheet does not cover has NO standard, not a nearby one", () => {
  assert.ok(findSpanStandard(CS8));
  assert.equal(findSpanStandard({ ...CS8, npsInch: 6 }), null, "6\" is not 8\"");
  assert.equal(findSpanStandard({ ...CS8, schedule: "40" }), null, "a heavier wall is a different span");
  assert.equal(findSpanStandard({ ...CS8, material: "stainless steel" }), null);
  assert.equal(findSpanStandard({ ...CS8, area: "pipe rack" }), null, "a rack sheet is its own sheet");
  assert.equal(findSpanStandard({ npsInch: null, schedule: "20", material: "carbon steel" }), null);
});

test("no standard says WHICH input is missing, because that is the thing to go and find", () => {
  const v = checkSpan({ lengthMm: 5000, configurations: ["straight"], npsInch: 8, schedule: null, material: null });
  assert.equal(v.status, "no standard");
  assert.match(v.basis, /schedule and material/);
});

/* --- the check ------------------------------------------------------------ */

test("a straight run is measured against the straight-run figure", () => {
  const within = checkSpan({ ...CS8, lengthMm: 7000, configurations: ["straight"] });
  assert.equal(within.status, "within");
  assert.equal(within.maxSpanMm, 7200);
  assert.equal(within.slackMm, 200);

  const over = checkSpan({ ...CS8, lengthMm: 7500, configurations: ["straight"] });
  assert.equal(over.status, "over");
  assert.equal(over.overByMm, 300);
});

test("a span with no configuration named is still a straight run, not unchecked", () => {
  const v = checkSpan({ ...CS8, lengthMm: 7000, configurations: [] });
  assert.equal(v.status, "within");
  assert.equal(v.governing, "straight");
});

test("THE SHORTEST APPLICABLE CASE GOVERNS", () => {
  // 7000mm is fine as an L turn (7700) and fine straight (7200), but this
  // span is also a branch tee (6000). Taking any but the smallest permits a
  // span the sheet does not.
  const v = checkSpan({ ...CS8, lengthMm: 7000, configurations: ["l-turn", "straight", "branch-tee"] });
  assert.equal(v.status, "over");
  assert.equal(v.maxSpanMm, 6000);
  assert.equal(v.governing, "branch-tee");
  assert.equal(v.overByMm, 1000);
  assert.match(v.basis, /also 7200mm straight run, 7700mm/, "the cases it beat are named, so the choice can be checked");
});

test("an L turn carries FURTHER than a straight run, and that is the sheet's own figure", () => {
  // Worth pinning because it reads like an error: the sheet draws 7700 for
  // the L and 7200 for the straight. Anyone 'correcting' it to the smaller
  // number would be overriding the standard with an assumption.
  assert.equal(checkSpan({ ...CS8, lengthMm: 7500, configurations: ["l-turn"] }).status, "within");
  assert.equal(checkSpan({ ...CS8, lengthMm: 7500, configurations: ["straight"] }).status, "over");
});

test("the vertical leg is checked SEPARATELY from the span it hangs off", () => {
  // A drop leg over its own 1100 limit, on a horizontal span that is fine.
  const v = checkSpan({ ...CS8, lengthMm: 5000, configurations: ["hanging-drop"], verticalLegMm: 1500 });
  assert.equal(v.status, "within", "5000 is inside the 5500 the drop-leg case allows");
  assert.equal(v.verticalLegOverByMm, 400);
  assert.match(v.basis, /vertical leg is 400mm over/);
});

test("a supported riser keeps the full span; an unsupported drop does not", () => {
  // The whole reading of the two "Max" cases, pinned: same 6000mm span, and
  // the answer turns on whether the vertical leg carries its own weight.
  assert.equal(checkSpan({ ...CS8, lengthMm: 6000, configurations: ["supported-riser"], verticalLegMm: 3000 }).status, "within");
  assert.equal(checkSpan({ ...CS8, lengthMm: 6000, configurations: ["hanging-drop"], verticalLegMm: 1000 }).status, "over");
});

test("a legal leg length raises no leg complaint", () => {
  const v = checkSpan({ ...CS8, lengthMm: 5000, configurations: ["hanging-drop"], verticalLegMm: 900 });
  assert.equal(v.verticalLegOverByMm, null);
  assert.doesNotMatch(v.basis, /vertical leg/);
});

test("exactly at the limit is within it, not over", () => {
  const v = checkSpan({ ...CS8, lengthMm: 7200, configurations: ["straight"] });
  assert.equal(v.status, "within");
  assert.equal(v.slackMm, 0);
});

test("a case the supplied sheet does not draw is unchecked, never passed", () => {
  const partial: SpanStandard[] = [{ ...PROCESS_AREA_SPANS[0], spans: { straight: 7200 }, verticalLegMaxMm: {} }];
  const v = checkSpan({ ...CS8, lengthMm: 9000, configurations: ["branch-tee"] }, partial);
  assert.equal(v.status, "no standard");
  assert.equal(v.maxSpanMm, null);
  assert.match(v.basis, /does not draw/);
});

/* --- the shape of a span, read off its legs' DIRECTIONS ------------------- */
//
// The lengths and the directions both come from the spool envelope, which is
// the same data the container check ships from. One reading of the drawing,
// used twice -- so the two pages can never quote different figures for one
// piece of pipe.

test("legs all running one way are a straight run", () => {
  assert.deepEqual(configurationsFromDirections(["E", "E", "E"]), ["straight"]);
  assert.deepEqual(configurationsFromDirections(["DOWN"]), ["straight"]);
  assert.deepEqual(configurationsFromDirections([]), ["straight"]);
});

test("AN L IS A CORNER IN PLAN; A V IS DOWN AND BACK UP", () => {
  // Worth 1300mm, and it used to be given away: with only "it turns" to go
  // on, both had to be offered and the shorter (the V, 6400) governed, so
  // every genuine L was judged 1300mm tighter than the sheet allows.
  assert.deepEqual(configurationsFromDirections(["E", "S"]), ["l-turn"]);
  assert.deepEqual(configurationsFromDirections(["DOWN", "UP"]), ["v-turn"]);

  // The reference ISO's own case: 937 EAST then 1500 SOUTH.
  const l = checkSpan({ ...CS8, lengthMm: 2437, configurations: configurationsFromDirections(["E", "S"]) });
  assert.equal(l.maxSpanMm, 7700);
  assert.equal(l.governing, "l-turn");
});

test("a vertical leg among horizontals offers BOTH vertical cases, and the shorter governs", () => {
  // The drawing does not say whether the leg carries its own support at the
  // base (7200) or hangs off the run (5500), so neither is assumed.
  const cases = configurationsFromDirections(["E", "DOWN"]);
  assert.deepEqual(cases, ["supported-riser", "hanging-drop"]);
  assert.equal(checkSpan({ ...CS8, lengthMm: 6000, configurations: cases }).maxSpanMm, 5500);
});

test("a V that also runs horizontally is still a V", () => {
  assert.ok(configurationsFromDirections(["E", "DOWN", "UP"]).includes("v-turn"));
});
