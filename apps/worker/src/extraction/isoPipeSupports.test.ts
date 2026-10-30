import test from "node:test";
import assert from "node:assert/strict";
import {
  findItemBalloons,
  pipeSupportsOf,
  supportCountCheck,
  supportSpans,
  supportSpansWhenComplete,
  supportTypeCode,
  type DimensionLeg,
  type PipeSupportHit,
} from "./isoPipeSupports";
import type { GeomPath } from "../pdfGeometry";

/** A stroked path from a list of points, with the bbox the reader would compute. */
function path(points: Array<[number, number]>, opts: Partial<GeomPath> = {}): GeomPath {
  const pts = points.map(([x, y]) => ({ x, y }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  return {
    points: pts,
    lineWidth: 0.72,
    paint: "stroke",
    closed: false,
    bbox,
    extent: Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0),
    ...opts,
  };
}

/** A 21 x 18 box, which is what every balloon on the reference ISO measures. */
const balloon = (x: number, y: number) =>
  path([
    [x, y],
    [x + 21, y],
    [x + 21, y + 18],
    [x, y + 18],
    [x, y],
  ]);

/** The pipe: heavy line weight, same rule the cut finder and tag tracer use. */
const pipe = (a: [number, number], b: [number, number]) => path([a, b], { lineWidth: 1.98 });

/* --- finding the balloons -------------------------------------------------- */

test("a balloon with a leader onto the pipe is found", () => {
  const hits = findItemBalloons([
    pipe([0, 200], [400, 200]),
    balloon(100, 100),
    path([
      [110, 118],
      [150, 197],
    ]),
  ]);
  assert.equal(hits.length, 1);
  assert.ok(Math.abs(hits[0].at.y - 200) < 1, "lands on the pipe");
  assert.ok(hits[0].offRunPt < 5);
});

test("A BOX WITH NO LEADER IS A TABLE CELL, not a balloon", () => {
  // The BOM table puts several hundred boxes of almost exactly balloon size
  // on this page. Requiring a leader is what separates them, which is why
  // the size bounds can stay loose.
  assert.deepEqual(findItemBalloons([pipe([0, 200], [400, 200]), balloon(100, 100)]), []);
});

test("a leader that lands nowhere near the run names something that is not on it", () => {
  const hits = findItemBalloons([
    pipe([0, 900], [400, 900]),
    balloon(100, 100),
    path([
      [110, 118],
      [150, 197],
    ]),
  ]);
  assert.deepEqual(hits, [], "700pt off the pipe is not pointing at it");
});

test("the same balloon drawn twice is one balloon", () => {
  const leader = path([
    [110, 118],
    [150, 197],
  ]);
  const hits = findItemBalloons([pipe([0, 200], [400, 200]), balloon(100, 100), balloon(100, 100), leader, leader]);
  assert.equal(hits.length, 1, "CAD stacks a layer on itself; that is not two supports");
});

/* --- which balloons are supports ------------------------------------------- */

test("a support is a BOM LOOKUP, not a symbol", () => {
  const paths = [
    pipe([0, 200], [600, 200]),
    balloon(100, 100),
    path([
      [110, 118],
      [150, 197],
    ]),
    balloon(300, 100),
    path([
      [310, 118],
      [350, 197],
    ]),
  ];
  const balloons = findItemBalloons(paths);
  assert.equal(balloons.length, 2);

  const items = [{ itemNo: "18", description: "PRIMARY SUPPORT - SC101", quantity: 1 }];
  const supports = pipeSupportsOf(balloons, { "1-1": "18", "1-2": "5" }, items, 1);
  assert.equal(supports.length, 1, "balloon 5 is an elbow, not a support");
  assert.equal(supports[0].itemNo, "18");
  assert.equal(supports[0].role, "primary");
  assert.equal(supports[0].typeCode, "SC101");
});

test("the balloon keeps ITS OWN cell, never renumbered by position among supports", () => {
  // The cells index a saved --labels-from reading. Renumbering them would
  // repoint every label at a different balloon the next time one is added.
  const paths = [
    pipe([0, 200], [600, 200]),
    balloon(100, 100),
    path([
      [110, 118],
      [150, 197],
    ]),
    balloon(300, 100),
    path([
      [310, 118],
      [350, 197],
    ]),
  ];
  const supports = pipeSupportsOf(findItemBalloons(paths), { "1-1": "5", "1-2": "18" }, [{ itemNo: "18", description: "PRIMARY SUPPORT - SC101", quantity: 1 }], 1);
  assert.equal(supports[0].cell, "1-2", "the second balloon stays 1-2 though it is the first support");
});

test("the BOM's quantity is the yardstick, and a shortfall is reported", () => {
  const found = [{ itemNo: "18" }, { itemNo: "18" }] as PipeSupportHit[];
  const items = [
    { itemNo: "18", description: "PRIMARY SUPPORT - SC101", quantity: 3 },
    { itemNo: "19", description: "SECONDARY SUPPORT - RB103", quantity: 2 },
  ];
  const check = supportCountCheck(found, items);
  assert.equal(check.complete, false);
  assert.equal(check.expected, 5);
  assert.deepEqual(check.perItem, [
    { itemNo: "18", expected: 3, found: 2 },
    { itemNo: "19", expected: 2, found: 0 },
  ]);
});

test("a support type code is not an ISA instrument tag", () => {
  assert.equal(supportTypeCode("PRIMARY SUPPORT - SC101"), "SC101");
  assert.equal(supportTypeCode("SECONDARY SUPPORT - RB103"), "RB103");
  assert.equal(supportTypeCode("PIPE BE SMLS A106 GR B"), null);
});

/* --- the spans ------------------------------------------------------------- */

// Page 1 of the reference ISO, at its real coordinates and real printed
// lengths: the east run from an elbow through two supports to a corner, then
// south to a third support.
const REFERENCE_LEGS: DimensionLeg[] = [
  // The 1412 vertical the run drops through before it turns east. Included
  // because it is what makes the first stretch interesting: 2912mm of pipe
  // before the first support, 1412 of it hanging vertically.
  { cell: "1-9", mm: 1412, from: { x: 343, y: 443 }, to: { x: 343, y: 568 }, degrees: 90 },
  { cell: "1-23", mm: 1500, from: { x: 343, y: 568 }, to: { x: 429, y: 519 }, degrees: 150 },
  { cell: "1-19", mm: 1000, from: { x: 429, y: 519 }, to: { x: 515, y: 470 }, degrees: 150 },
  { cell: "1-17", mm: 937, from: { x: 515, y: 470 }, to: { x: 624, y: 407 }, degrees: 150 },
  { cell: "1-5", mm: 1500, from: { x: 624, y: 407 }, to: { x: 676, y: 437 }, degrees: 30 },
  { cell: "1-7", mm: 1186, from: { x: 676, y: 437 }, to: { x: 782, y: 498 }, degrees: 30 },
];

const support = (cell: string, x: number, y: number): PipeSupportHit =>
  ({ cell, at: { x, y }, itemNo: "18", role: "primary" }) as PipeSupportHit;

/** The reference sheet's three supports, walked. */
const REFERENCE_SPANS = supportSpans(REFERENCE_LEGS, [
  support("1-8", 424, 522),
  support("1-10", 509, 473),
  support("1-13", 679, 439),
]);

test("A SPAN IS A SUM OF PRINTED LENGTHS, never a page measurement", () => {
  // The three supports as the geometry actually located them, 3.6-6.7pt off
  // their chain node because the leader stops at the support bar.
  const spans = REFERENCE_SPANS.filter((s) => s.kind === "span");
  assert.deepEqual(
    spans.map((s) => [s.fromCell, s.toCell, s.mm, s.legs, s.turns]),
    [
      ["1-8", "1-10", 1000, ["1-19"], 0],
      ["1-10", "1-13", 2437, ["1-17", "1-5"], 1],
    ]
  );
});

test("THE RUN HAS TWO ENDS, and the pipe past the last support is unsupported too", () => {
  // Reporting only the gaps BETWEEN supports would pass this sheet in
  // silence while 2912mm of it hangs off the front, 1412 of that vertical.
  const ends = REFERENCE_SPANS.filter((s) => s.kind === "run-end");
  assert.deepEqual(
    ends.map((s) => [s.fromCell, s.toCell, s.mm, s.verticalLegMm]),
    [
      ["(run end)", "1-8", 2912, 1412],
      ["1-13", "(run end)", 1186, null],
    ]
  );
});

test("a span crossing an elbow is reported as TURNING, which shortens what it may be", () => {
  const turning = REFERENCE_SPANS.find((s) => s.fromCell === "1-10" && s.toCell === "1-13")!;
  assert.equal(turning.turns, 1, "937 east then 1500 south is one change of direction");
});

test("a leg whose label was never read leaves the span UNKNOWN, not short", () => {
  const legs = REFERENCE_LEGS.map((l) => (l.cell === "1-5" ? { ...l, mm: null } : l));
  const spans = supportSpans(legs, [support("1-10", 509, 473), support("1-13", 679, 439)]).filter((s) => s.kind === "span");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].mm, null, "937 + unread is not 937");
  assert.deepEqual(spans[0].legs, ["1-17", "1-5"]);
});

test("a PRIMARY and the SECONDARY installed on it are one support point", () => {
  // Both land on the same node. Two points there would report a zero-length
  // span between a support and the one bolted on top of it.
  const spans = supportSpans(REFERENCE_LEGS, [
    support("1-8", 424, 522),
    { ...support("1-9", 434, 516), itemNo: "19", role: "secondary" },
    support("1-10", 509, 473),
  ]).filter((s) => s.kind === "span");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].mm, 1000);
});

test("a support that sits MID-LEG gets no span rather than an apportioned one", () => {
  // Splitting a printed leg by page distance would be measuring off a
  // drawing that is not to scale -- the thing this whole module avoids.
  const spans = supportSpans(REFERENCE_LEGS, [support("1-8", 424, 522), support("x", 470, 495)]).filter((s) => s.kind === "span");
  assert.equal(spans.length, 0);
});

/* --- read the supports through FIRST, then do the span -------------------- */

test("A MISSED SUPPORT MERGES THE TWO GAPS EITHER SIDE OF IT", () => {
  // The failure the gate exists to stop, shown on the reference geometry:
  // drop the middle support and the outer two pair with each other, turning
  // 1000 + 1437 into one invented 2437mm gap.
  const all = REFERENCE_SPANS.filter((s) => s.kind === "span");
  const missingMiddle = supportSpans(REFERENCE_LEGS, [support("1-8", 424, 522), support("1-13", 679, 439)]).filter(
    (s) => s.kind === "span"
  );

  assert.deepEqual(all.map((s) => s.mm), [1000, 2437]);
  assert.deepEqual(missingMiddle.map((s) => s.mm), [3437], "one gap where the drawing has two");
});

test("no span is measured until every support the BOM calls for is found", () => {
  const supports = [support("1-8", 424, 522), support("1-13", 679, 439)];
  const items = [{ itemNo: "18", description: "PRIMARY SUPPORT - SC101", quantity: 3 }];
  const { spans, withheld } = supportSpansWhenComplete(REFERENCE_LEGS, supports, supportCountCheck(supports, items));

  assert.deepEqual(spans, [], "two of three found is not enough to know which are consecutive");
  assert.match(withheld ?? "", /item 18: 2 of 3/);
  assert.match(withheld ?? "", /merges the two gaps/);
});

test("a complete read lets the spans through unchanged", () => {
  const supports = [support("1-8", 424, 522), support("1-10", 509, 473), support("1-13", 679, 439)];
  const items = [{ itemNo: "18", description: "PRIMARY SUPPORT - SC101", quantity: 3 }];
  const { spans, withheld } = supportSpansWhenComplete(REFERENCE_LEGS, supports, supportCountCheck(supports, items));

  assert.equal(withheld, null);
  assert.deepEqual(spans.filter((s) => s.kind === "span").map((s) => s.mm), [1000, 2437]);
});

test("a sheet the BOM puts no supports on withholds nothing -- there is nothing to withhold", () => {
  const { spans, withheld } = supportSpansWhenComplete(REFERENCE_LEGS, [], supportCountCheck([], []));
  assert.deepEqual(spans, []);
  assert.equal(withheld, null, "silence here is correct, and must not be dressed up as a failure");
});
