// Finding the FLOW ARROWS on an isometric.
//
// The geometry below is real, read off page 2 of the revised reference ISO at
// (225.8, 780.8) with scripts/probe-shape-at.ts -- the filled head, the stroked
// outline drawn round it, and the heavy pipe polyline it sits on. Using the
// drawing's own numbers rather than an idealised triangle matters here, because
// what the detector leans on is the shape CAD actually emits.
import test from "node:test";
import assert from "node:assert/strict";
import { apexOf, findFlowArrows } from "./isoFlowArrows";
import type { GeomPath } from "../pdfGeometry";

const path = (p: Partial<GeomPath> & Pick<GeomPath, "points" | "paint">): GeomPath => {
  const xs = p.points.map((q) => q.x);
  const ys = p.points.map((q) => q.y);
  const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  return {
    closed: false,
    lineWidth: 0.72,
    bbox,
    extent: Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0),
    ...p,
  };
};

/** The pipe the arrow sits on: heaviest thing drawn, running up-right at 330. */
const PIPE = path({
  paint: "stroke",
  lineWidth: 1.98,
  points: [
    { x: 200.0, y: 795.0 },
    { x: 260.0, y: 760.4 },
  ],
});

/** The filled head. */
const HEAD = path({
  paint: "fillStroke",
  points: [
    { x: 226.6, y: 782.2 },
    { x: 218.7, y: 782.2 },
    { x: 233.0, y: 776.7 },
  ],
});

/** The stroked four-point outline drawn round it, which crosses itself. */
const OUTLINE = path({
  paint: "stroke",
  points: [
    { x: 233.0, y: 776.7 },
    { x: 218.7, y: 782.2 },
    { x: 223.4, y: 784.9 },
    { x: 233.0, y: 776.7 },
  ],
});

// Rebuilt from the moved points, NOT spread from the original: carrying the
// old bbox through would leave `centre()` reporting where the shape used to be.
const shift = (p: GeomPath, dx: number, dy: number) =>
  path({ paint: p.paint, lineWidth: p.lineWidth, points: p.points.map((q) => ({ x: q.x + dx, y: q.y + dy })) });

test("a flow arrow is found on the pipe it is drawn on", () => {
  const found = findFlowArrows([PIPE, HEAD, OUTLINE]);
  assert.equal(found.length, 1);
  assert.ok(found[0].onPipePt < 4, `sits ${found[0].onPipePt} off the pipe`);
  assert.ok(found[0].alongDeg < 10, `points ${found[0].alongDeg} deg off its axis`);
});

test("it points the way the fluid goes, not back up the pipe", () => {
  // The head's apex is at (233.0, 776.7) -- up and to the right on the page,
  // and page y runs DOWN, so dir.x is positive and dir.y negative.
  const [a] = findFlowArrows([PIPE, HEAD, OUTLINE]);
  assert.deepEqual(a.apex, { x: 233.0, y: 776.7 });
  assert.ok(a.dir.x > 0.8, `dir.x ${a.dir.x}`);
  assert.ok(a.dir.y < 0, `dir.y ${a.dir.y} -- page y runs DOWN, so up-page is negative`);
});

test("WITHOUT its outline it is just an arrowhead, and not taken", () => {
  // This is the whole discriminator. A leader's arrowhead and a dimension's
  // terminator are filled triangles too, and a page carries thousands of them;
  // the stroked self-crossing outline is what a flow arrow has and they do not.
  assert.deepEqual(findFlowArrows([PIPE, HEAD]), []);
});

test("an arrow away from the pipe is not a flow arrow", () => {
  // A leader's head can point along a pipe's axis from well off it, because a
  // leader is drawn on the same three isometric axes as everything else.
  assert.deepEqual(findFlowArrows([PIPE, shift(HEAD, 0, -40), shift(OUTLINE, 0, -40)]), []);
});

test("an arrow ACROSS the pipe is not a flow arrow", () => {
  // A leader arriving at the run points at it, not along it.
  const across = path({
    paint: "fillStroke",
    points: [
      { x: 226.0, y: 774.0 },
      { x: 232.0, y: 785.0 },
      { x: 226.6, y: 782.2 },
    ],
  });
  const acrossOutline = path({
    paint: "stroke",
    points: [
      { x: 226.0, y: 774.0 },
      { x: 232.0, y: 785.0 },
      { x: 221.0, y: 781.0 },
      { x: 226.0, y: 774.0 },
    ],
  });
  const found = findFlowArrows([PIPE, across, acrossOutline]);
  assert.deepEqual(found, [], found.length ? `took one at ${found[0].alongDeg.toFixed(1)}deg off axis` : "");
});

test("a drawing with no flow arrows yields none, not a best guess", () => {
  // The original reference ISO draws none on any of its five sheets, and the
  // detector returns nothing on all five. A run-order rule that silently
  // invented a direction would be worse than falling back to the numbering.
  assert.deepEqual(findFlowArrows([PIPE]), []);
  assert.deepEqual(findFlowArrows([]), []);
});

test("the apex is the tip, taken from the BASE midpoint", () => {
  // Not the centroid: that sits a third of the way up and skews the direction
  // on a stubby head.
  const a = apexOf(HEAD);
  assert.deepEqual(a?.apex, { x: 233.0, y: 776.7 });
});
