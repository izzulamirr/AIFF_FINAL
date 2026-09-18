import test from "node:test";
import assert from "node:assert/strict";
import { findDimensions, pipeAttachment } from "./isoDimensions";
import type { GeomPath, Point } from "../pdfGeometry";

// Built rather than read off the reference ISO on purpose. That drawing is one
// CAD exporter's habits at one scale on three axes, and a rule fitted to it
// would look exactly like a rule that works -- so these cases use other sizes,
// other axes and shapes the reference never draws.

const path = (points: Point[], paint: GeomPath["paint"], lineWidth = 0.7): GeomPath => {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  return { points, lineWidth, paint, closed: paint !== "stroke", bbox, extent: Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) };
};

const unit = (deg: number): Point => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
const along = (from: Point, dir: Point, d: number): Point => ({ x: from.x + dir.x * d, y: from.y + dir.y * d });

/** A filled triangle whose long edge runs along `dir`, centred on `at`. */
const head = (at: Point, dir: Point, len = 7, wide = 2): GeomPath => {
  const perp = { x: -dir.y, y: dir.x };
  return path(
    [
      { x: at.x - (dir.x * len) / 2 + perp.x * wide, y: at.y - (dir.y * len) / 2 + perp.y * wide },
      { x: at.x - (dir.x * len) / 2 - perp.x * wide, y: at.y - (dir.y * len) / 2 - perp.y * wide },
      { x: at.x + (dir.x * len) / 2, y: at.y + (dir.y * len) / 2 },
    ],
    "fill"
  );
};

/** Outlined text: small, and many points. Never a filled blob. */
const glyph = (at: Point, size = 6): GeomPath =>
  path(
    Array.from({ length: 10 }, (_, i) => ({
      x: at.x + (Math.cos((i / 10) * Math.PI * 2) * size) / 2,
      y: at.y + (Math.sin((i / 10) * Math.PI * 2) * size) / 2,
    })),
    "stroke"
  );

const APEX = 3.5; // half an arrowhead: its apex sits this far from its centre

/**
 * A dimension broken to make room for its number, laid out along `deg`.
 * `at` and `at + span` are the ARROW TIPS -- the extent actually measured --
 * and `halfLen` is how much line is drawn from each tip before the text.
 */
function splitDimension(opts: {
  at: Point;
  deg: number;
  span: number;
  halfLen: number;
  /** Where each arrowhead points. "out" is a real dimension; "in" is what the
   *  junction of two chained dimensions looks like. */
  facing?: "out" | "in";
  label?: boolean;
  lineWidth?: number;
  /** How far clear of its arrowhead each half starts. */
  gapPad?: number;
}): GeomPath[] {
  const { at, deg, span, halfLen, facing = "out", label = true, lineWidth = 0.7, gapPad = 4 } = opts;
  const d = unit(deg);
  const back = { x: -d.x, y: -d.y };
  const lo = at;
  const hi = along(at, d, span);
  const out: GeomPath[] = [];
  if (facing === "out") {
    // Arrows point INWARD with their apexes ON the line's ends, which is how
    // the reference drawing does it: the 184's tips are its arrows' apexes.
    out.push(head(along(lo, d, -APEX), d), head(along(hi, d, APEX), back));
    out.push(path([lo, along(lo, d, halfLen)], "stroke", lineWidth));
    out.push(path([hi, along(hi, d, -halfLen)], "stroke", lineWidth));
  } else {
    out.push(head(along(lo, d, -gapPad), d), head(along(hi, d, gapPad), back));
    out.push(path([along(lo, d, -gapPad), along(lo, d, -(gapPad + halfLen))], "stroke", lineWidth));
    out.push(path([along(hi, d, gapPad), along(hi, d, gapPad + halfLen)], "stroke", lineWidth));
  }
  if (label) out.push(glyph(along(at, d, span / 2)));
  return out;
}

const only = (paths: GeomPath[]) => {
  const r = findDimensions(paths);
  return { dims: r.dimensions, why: r.splitRejections.map((s) => s.why) };
};

/* --- the shape that was being missed ------------------------------------- */

test("a dimension line BROKEN for its own number is still a dimension", () => {
  const { dims } = only(splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18 }));
  assert.equal(dims.length, 1);
  assert.equal(dims[0].drawnAs, "split");
  assert.equal(dims[0].pagePt, 60);
  assert.equal(dims[0].degrees, 90);
  assert.ok(dims[0].labelBox, "the number in the gap must be boxed for reading");
});

test("the span of a split dimension is measured ARROWHEAD to ARROWHEAD", () => {
  // Not tail to tail, and not the length of either drawn half: the extent is
  // where the arrows point, and the halves stop well short of it.
  const { dims } = only(splitDimension({ at: { x: 40, y: 500 }, deg: 30, span: 120, halfLen: 45 }));
  assert.equal(dims.length, 1);
  assert.equal(dims[0].pagePt, 120);
  assert.equal(dims[0].degrees, 30);
});

test("a split dimension is found on every drawing axis", () => {
  for (const deg of [30, 90, 150]) {
    const { dims } = only(splitDimension({ at: { x: 300, y: 300 }, deg, span: 75, halfLen: 25 }));
    assert.equal(dims.length, 1, `axis ${deg}`);
    assert.equal(dims[0].drawnAs, "split", `axis ${deg}`);
  }
});

/* --- what must NOT become a dimension ------------------------------------ */

test("where two CHAINED dimensions meet, the facing arrows are not a dimension", () => {
  // The closing arrow of one and the opening arrow of the next are collinear
  // and a real distance apart -- but they point INWARD, at each other.
  const { dims, why } = only(splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 14, facing: "in" }));
  assert.deepEqual(dims, []);
  assert.deepEqual(why, ["heads face inward"]);
});

test("a line broken for something OTHER than its number is not a dimension", () => {
  const { dims, why } = only(splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18, label: false }));
  assert.deepEqual(dims, []);
  assert.deepEqual(why, ["no number in the gap"]);
});

test("two halves reaching across a whole neighbouring dimension do not pair", () => {
  // The outermost arrows of a three-deep chain are collinear and outward
  // facing; only the gap between them gives them away.
  const { dims, why } = only(splitDimension({ at: { x: 100, y: 100 }, deg: 90, span: 200, halfLen: 12 }));
  assert.deepEqual(dims, []);
  assert.deepEqual(why, ["gap too large"]);
});

test("halves on PARALLEL but different lines do not pair", () => {
  // Two dimensions stacked side by side, each with one arrow read.
  const a = splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18 });
  const b = splitDimension({ at: { x: 118, y: 200 }, deg: 90, span: 60, halfLen: 18 });
  const { dims } = only([...a, ...b]);
  assert.equal(dims.length, 2);
  assert.ok(dims.every((d) => d.drawnAs === "split"));
});

test("a span too short to be worth reading is not taken", () => {
  const { dims } = only(splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 13, halfLen: 4 }));
  assert.deepEqual(dims, []);
});

test("a SHORT continuous span with its arrows OUTSIDE is still a dimension", () => {
  // The real shape, built to sheet 2's 920: one unbroken line with an
  // arrowhead beyond each end, apexes further apart than the line is long.
  // Matching a head to a line end on its CENTRE alone missed the lower end of
  // that one by 10.5pt while finding the upper at 2.9, so the pair never
  // formed and 920mm went unread. The apex is the part that lands on the end.
  const d = unit(150);
  const from = { x: 600, y: 400 };
  const to = along(from, d, 82);
  const perp = { x: -d.y, y: d.x };
  const back = { x: -d.x, y: -d.y };
  const paths = [
    // Apexes sit ~6pt BEYOND each end, pointing back in at the witnesses.
    head(along(from, back, 6 + APEX), d),
    head(along(to, d, 6 + APEX), back),
    path([from, to], "stroke"),
    glyph(along({ x: (from.x + to.x) / 2 + perp.x * 8, y: (from.y + to.y) / 2 + perp.y * 8 }, d, 0)),
  ];
  const { dims } = only(paths);
  assert.equal(dims.length, 1);
  // Measured APEX to APEX, so longer than the drawn line.
  assert.ok(dims[0].pagePt > 82, `measured ${dims[0].pagePt}, should exceed the 82pt line`);
});

test("PIPE-weight lines never make a dimension, however they are terminated", () => {
  // A weld dot is a small filled blob much like an arrowhead, so a pipe with a
  // weld at each end is the shape most likely to be mistaken for one.
  const { dims } = only(splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18, lineWidth: 1.98 }));
  assert.deepEqual(dims, []);
});

test("an arrowhead that does not point ALONG its line is not an arrowhead", () => {
  // Same size, same filled triangle, turned across the line: a fitting or a
  // weld mark on the pipe, not a terminator.
  const d = unit(90);
  const across = unit(0);
  const paths = [
    head({ x: 100, y: 200 }, across),
    head({ x: 100, y: 260 }, across),
    path([{ x: 100, y: 204 }, { x: 100, y: 218 }], "stroke"),
    path([{ x: 100, y: 242 }, { x: 100, y: 256 }], "stroke"),
    glyph(along({ x: 100, y: 200 }, d, 30)),
  ];
  assert.deepEqual(only(paths).dims, []);
});

/* --- the continuous form still behaves ----------------------------------- */

test("a dimension drawn as ONE line, arrowheads at both ends, still reads", () => {
  const d = unit(150);
  const from = { x: 600, y: 400 };
  const to = along(from, d, 90);
  const perp = { x: -d.y, y: d.x };
  const paths = [
    head(from, d),
    head(to, d),
    path([from, to], "stroke"),
    // Its number stands OFF the line, not in it.
    glyph(along({ x: (from.x + to.x) / 2 + perp.x * 8, y: (from.y + to.y) / 2 + perp.y * 8 }, d, 0)),
  ];
  const { dims } = only(paths);
  assert.equal(dims.length, 1);
  assert.equal(dims[0].drawnAs, "line");
  assert.equal(dims[0].pagePt, 90);
  assert.ok(dims[0].labelBox);
});

/* --- WHICH printed number belongs to this dimension ---------------------- */

test("the number is taken from the dimension's OWN LINE, not from the nearest text", () => {
  // N-15's WEST extent, and the shape that hid it. The extent is too small to
  // hold its number, so CAD pushes the number OUT ALONG the line, past the
  // arrowheads -- while the sheet prints an "FW" note for the field weld
  // right beside the same span, closer to the midpoint than the number is.
  // Seeding on whatever is nearest picks the note and then grows a confident,
  // tidy box round it.
  const d = unit(30);
  const from = { x: 300, y: 500 };
  const to = along(from, d, 26);
  const perp = { x: -d.y, y: d.x };
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const back = { x: -d.x, y: -d.y };
  const number = along(mid, back, 38); // out past the arrowheads, ON the line
  const note = { x: mid.x + perp.x * 17, y: mid.y + perp.y * 17 }; // the "FW"
  const paths = [
    head(along(from, back, 6 + APEX), d),
    head(along(to, d, 6 + APEX), back),
    path([from, to], "stroke"),
    glyph(number),
    glyph({ x: number.x - 7, y: number.y - 4 }),
    glyph(note),
    glyph({ x: note.x + 6, y: note.y }),
  ];
  const { dims } = only(paths);
  assert.equal(dims.length, 1);
  const box = dims[0].labelBox;
  assert.ok(box);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const across = Math.abs((cx - mid.x) * -d.y + (cy - mid.y) * d.x);
  assert.ok(across < 8, `label sits ${across.toFixed(1)}pt across its own line -- it took the note`);
});

test("text only to the SIDE means this dimension has no number, and none is claimed", () => {
  // A blank is the honest answer. A crop of somebody else's text invites a
  // reading, and a wrong length is worse than a missing one.
  const d = unit(90);
  const from = { x: 700, y: 200 };
  const to = along(from, d, 70);
  const perp = { x: -d.y, y: d.x };
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const paths = [
    head(from, d),
    head(to, d),
    path([from, to], "stroke"),
    glyph({ x: mid.x + perp.x * 20, y: mid.y + perp.y * 20 }),
    glyph({ x: mid.x + perp.x * 20 + 6, y: mid.y + perp.y * 20 }),
  ];
  const { dims } = only(paths);
  assert.equal(dims.length, 1);
  assert.equal(dims[0].labelBox, null);
});

test("a continuous dimension does not read its own ticks as its number", () => {
  const d = unit(90);
  const from = { x: 200, y: 100 };
  const to = along(from, d, 80);
  const paths = [head(from, d), head(to, d), path([from, to], "stroke")];
  const { dims } = only(paths);
  assert.equal(dims.length, 1);
  assert.equal(dims[0].labelBox, null);
});

test("both forms on one page are found, and counted once each", () => {
  const paths = [
    ...splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18 }),
    ...splitDimension({ at: { x: 400, y: 600 }, deg: 30, span: 110, halfLen: 42 }),
  ];
  const d = unit(150);
  const from = { x: 800, y: 300 };
  paths.push(head(from, d), head(along(from, d, 95), d), path([from, along(from, d, 95)], "stroke"));
  const { dims } = only(paths);
  assert.equal(dims.length, 3);
  assert.equal(dims.filter((x) => x.drawnAs === "split").length, 2);
  assert.equal(dims.filter((x) => x.drawnAs === "line").length, 1);
});

/* --- does it measure PIPE, or is it a detail? ---------------------------- */

/** A witness (extension) line crossing `tip`, running at `deg`. */
const witness = (tip: Point, deg: number, len = 50): GeomPath => {
  const u = unit(deg);
  return path([along(tip, u, -len / 2), along(tip, u, len / 2)], "stroke");
};

test("two PARALLEL witness lines make it a pipe dimension, and name their axis", () => {
  // Witness lines run on ANOTHER isometric axis, not perpendicular: on the
  // reference ISO the 184's pair both run at 30deg while it is vertical.
  const paths = [
    ...splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18 }),
    witness({ x: 100, y: 200 }, 30),
    witness({ x: 100, y: 260 }, 30),
  ];
  const { dims } = only(paths);
  assert.equal(dims.length, 1);
  assert.equal(dims[0].measuresPipe, true);
  assert.equal(dims[0].witnessDegrees, 30);
});

test("a dimension bracketing nothing is not a pipe dimension", () => {
  const { dims } = only(splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18 }));
  assert.equal(dims.length, 1);
  assert.equal(dims[0].measuresPipe, false);
  assert.equal(dims[0].witnessDegrees, null);
});

test("witness lines that are NOT parallel cannot both serve one dimension", () => {
  const paths = [
    ...splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18 }),
    witness({ x: 100, y: 200 }, 30),
    witness({ x: 100, y: 260 }, 150),
  ];
  assert.equal(only(paths).dims[0].measuresPipe, false);
});

test("ONE witness line is enough -- an end landing on the object has none drawn", () => {
  const paths = [
    ...splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18 }),
    witness({ x: 100, y: 200 }, 150),
  ];
  const { dims } = only(paths);
  assert.equal(dims[0].measuresPipe, true);
  assert.equal(dims[0].witnessDegrees, 150);
});

test("a line running ALONG the dimension is not a witness for it", () => {
  // The dimension's own axis, and the neighbouring dimension in a chain.
  const paths = [
    ...splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18 }),
    witness({ x: 100, y: 200 }, 90),
    witness({ x: 100, y: 260 }, 90),
  ];
  assert.equal(only(paths).dims[0].measuresPipe, false);
});

test("the parallel PAIR is looked for across both ends, not the longest at each", () => {
  // Several lines pass close to a tip. Taking each end's longest candidate
  // independently picked two different ones and lost sheet 3's 721 main-run
  // dimension, whose tips each have a leader crossing them as well.
  const paths = [
    ...splitDimension({ at: { x: 100, y: 200 }, deg: 90, span: 60, halfLen: 18 }),
    witness({ x: 100, y: 200 }, 30, 40),
    witness({ x: 100, y: 200 }, 150, 90), // a longer decoy at the near end
    witness({ x: 100, y: 260 }, 30, 40),
  ];
  const { dims } = only(paths);
  assert.equal(dims[0].measuresPipe, true);
  assert.equal(dims[0].witnessDegrees, 30);
});

// --- sliding a dimension back onto the pipe it measures -------------------
//
// Deliberately synthetic. The rule was found on one drawing, so it is pinned
// against geometry built by hand here, where the answer is known by
// construction rather than by having looked at the reference ISO.

const pipe = (a: [number, number], b: [number, number]) => ({ a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } });

test("a dimension offset from a parallel run lands on it, fully covered", () => {
  // Vertical dimension at x=60, vertical run at x=100, witness horizontal.
  const at = pipeAttachment({ x: 60, y: 100 }, { x: 60, y: 200 }, 0, [pipe([100, 100], [100, 200])]);
  assert.ok(at);
  assert.equal(at.coverage, 1);
  assert.deepEqual(at.from, { x: 100, y: 100 });
  assert.deepEqual(at.to, { x: 100, y: 200 });
});

test("a run that stops partway covers only part of the span", () => {
  const at = pipeAttachment({ x: 60, y: 100 }, { x: 60, y: 200 }, 0, [pipe([100, 100], [100, 150])]);
  assert.ok(at);
  assert.equal(at.coverage, 0.5);
});

test("NO pipe under the span is the bolted-joint case, and reads zero", () => {
  // The run stops short of the dimension and resumes past it: a valve
  // bolted in between two flanges, which ships on its own.
  const at = pipeAttachment({ x: 60, y: 100 }, { x: 60, y: 200 }, 0, [pipe([100, 0], [100, 100]), pipe([100, 200], [100, 300])]);
  assert.ok(at);
  assert.equal(at.coverage, 0);
});

test("a run drawn twice over itself is not counted twice", () => {
  const at = pipeAttachment({ x: 60, y: 100 }, { x: 60, y: 200 }, 0, [pipe([100, 100], [100, 150]), pipe([100, 100], [100, 150])]);
  assert.ok(at);
  assert.equal(at.coverage, 0.5, "union, not sum -- CAD stacks lines");
});

test("a run on ANOTHER axis is not what this dimension measures", () => {
  const at = pipeAttachment({ x: 60, y: 100 }, { x: 60, y: 200 }, 0, [pipe([100, 100], [200, 100])]);
  assert.equal(at?.coverage ?? 0, 0);
});

test("the offset is chosen by which run has the most pipe under it", () => {
  // Two parallel runs reachable along the witness; the further one is the
  // one actually bracketed.
  const at = pipeAttachment({ x: 60, y: 100 }, { x: 60, y: 200 }, 0, [pipe([100, 100], [100, 120]), pipe([160, 100], [160, 200])]);
  assert.ok(at);
  assert.equal(at.coverage, 1);
  assert.equal(at.from.x, 160);
});

test("a run out of the witness line's reach is not reached", () => {
  const at = pipeAttachment({ x: 60, y: 100 }, { x: 60, y: 200 }, 0, [pipe([900, 100], [900, 200])]);
  assert.equal(at, null);
});

test("without a witness direction there is nothing to slide along", () => {
  assert.equal(pipeAttachment({ x: 60, y: 100 }, { x: 60, y: 200 }, null, [pipe([100, 100], [100, 200])]), null);
});

test("a witness at 30deg reaches a run offset along 30deg", () => {
  // The isometric case: the witness runs on ANOTHER drawing axis, not
  // perpendicular. Sliding 100pt at 30deg moves (86.6, 50).
  const at = pipeAttachment({ x: 0, y: 0 }, { x: 0, y: 100 }, 30, [pipe([86.6, 50], [86.6, 150])]);
  assert.ok(at);
  assert.equal(at.coverage, 1);
  assert.ok(Math.abs(at.from.x - 86.6) < 0.2 && Math.abs(at.from.y - 50) < 0.2);
});
