import test from "node:test";
import assert from "node:assert/strict";
import { assignSpools, boltedJoints, flankingWelds, type Bar, type WeldRow } from "./isoSpoolCuts";
import type { Pt } from "./isoWeldMarks";

const welds = (spec: Array<[number, string, string]>): WeldRow[] =>
  spec.map(([weldNo, weldType, size]) => ({ weldNo, weldType, size }));

const TAGS2 = ["N-04", "N-05", "N-06", "N-07", "N-08", "N-09"];
// Sheet 2 of the reference ISO, hand-verified.
const SHEET2 = welds([
  [1, "BW", "200"], [2, "BW", "200"], [3, "BW", "200"], [4, "BW", "200"], [5, "BW", "15"], [6, "TH", "15"],
  [7, "BW", "200"], [8, "BW", "200"], [9, "TW", "200"], [10, "BW", "80"], [11, "BW", "80"],
  [12, "BW", "200"], [13, "BW", "200"], [14, "BW", "150"], [15, "BW", "150"],
  [16, "BW", "200"], [17, "BW", "200"],
  [18, "BW", "200"], [19, "BW", "200"], [20, "TW", "200"], [21, "BW", "80"], [22, "BW", "80"],
  [23, "BW", "200"], [24, "BW", "200"], [25, "BW", "200"], [26, "BW", "200"],
]);

const members = (m: Map<number, string>) => {
  const out: Record<string, number[]> = {};
  for (const [no, tag] of [...m.entries()].sort((a, b) => a[0] - b[0])) (out[tag] ??= []).push(no);
  return out;
};

test("sheet 2's cuts give exactly the hand-verified spool membership", () => {
  assert.deepEqual(members(assignSpools(SHEET2, [6, 11, 14, 17, 22], TAGS2)), {
    "N-04": [1, 2, 3, 4, 5, 6],
    "N-05": [7, 8, 9, 10, 11],
    "N-06": [12, 13, 14],
    "N-07": [15, 16, 17],
    "N-08": [18, 19, 20, 21, 22],
    "N-09": [23, 24, 25, 26],
  });
});

test("branch welds ride along inside the spool their takeoff belongs to", () => {
  // 5/6 (15mm) and 10/11 (80mm) are branches; they must not start a new spool
  // even though a cut sits close by.
  const m = assignSpools(SHEET2, [6, 11, 14, 17, 22], TAGS2);
  assert.equal(m.get(5), "N-04");
  assert.equal(m.get(6), "N-04");
  assert.equal(m.get(10), "N-05");
  assert.equal(m.get(11), "N-05");
});

test("a cut after every weld but the last still fills every spool", () => {
  const w = welds([[1, "BW", "50"], [2, "FW", "50"], [3, "BW", "50"]]);
  assert.deepEqual(members(assignSpools(w, [1, 2], ["A", "B", "C"])), { A: [1], B: [2], C: [3] });
});

test("no cuts puts every weld in the single spool", () => {
  const w = welds([[1, "BW", "50"], [2, "BW", "50"]]);
  assert.deepEqual(members(assignSpools(w, [], ["ONLY"])), { ONLY: [1, 2] });
});

test("weld numbering that starts above 1 and skips still partitions cleanly", () => {
  const w = welds([[7, "BW", "6\""], [9, "BW", "6\""], [10, "FW", "6\""], [14, "BW", "6\""]]);
  assert.deepEqual(members(assignSpools(w, [10], ["S-1", "S-2"])), { "S-1": [7, 9, 10], "S-2": [14] });
});

test("a weld beyond the last spool tag is left unassigned rather than guessed", () => {
  const w = welds([[1, "BW", "50"], [2, "BW", "50"], [3, "BW", "50"]]);
  const m = assignSpools(w, [1, 2], ["A", "B"]); // two tags, but two cuts imply three spools
  assert.equal(m.get(1), "A");
  assert.equal(m.get(2), "B");
  assert.equal(m.has(3), false);
});

// --- Sheet 5 of the reference ISO ------------------------------------------
// Its three boundaries are a ball valve, a FLANGED SWING check valve and a
// WAFER check valve, and only the ball valve has a valve symbol that can be
// recognised -- the swing check is drawn as nothing but the gap between its two
// flanges. Verified against the sheet four ways: the BOM's own item list, the
// flange pairs on the drawing, the count of printed spool tags, and each spool
// tag's pointer leader landing inside the block of welds claimed for it.
const TAGS5 = ["N-15", "N-16", "N-17", "N-18"];
const SHEET5 = welds([
  [1, "BW", "200"], [2, "BW", "200"], [3, "BW", "200"], [4, "TW", "80"], [5, "BW", "80"],
  [6, "BW", "200"], [7, "BW", "200"], [8, "BW", "200"], [9, "TW", "80"], [10, "BW", "80"],
  [11, "BW", "200"], [12, "BW", "200"], [13, "BW", "200"], [14, "BW", "200"],
]);

test("sheet 5's cuts give the membership its spool tag leaders point at", () => {
  assert.deepEqual(members(assignSpools(SHEET5, [5, 10, 12], TAGS5)), {
    "N-15": [1, 2, 3, 4, 5],
    "N-16": [6, 7, 8, 9, 10],
    "N-17": [11, 12],
    "N-18": [13, 14],
  });
});

test("an 80mm branch rides along even when its welds are numbered across a cut", () => {
  // The cut sits between main-run welds 8 and 11; the 80mm branch numbered 9/10
  // in between belongs to the spool that closes there, not the one after it.
  const m = assignSpools(SHEET5, [5, 10, 12], TAGS5);
  assert.equal(m.get(9), "N-16");
  assert.equal(m.get(10), "N-16");
  assert.equal(m.get(11), "N-17");
});

// --- Finding a bolted joint -------------------------------------------------
// A spool ends at the BOLTS, not at a valve symbol, so a joint is a pair of
// flange bars facing each other. Coordinates here are deliberately a round
// made-up scale, not the reference sheet's, so the rules cannot quietly become
// fitted to one drawing.
const bar = (x: number, y: number, dir: Pt, long = 20): Bar => ({ at: { x, y }, dir, long });
const ACROSS: Pt = { x: 0, y: 1 };  // face drawn across a horizontal pipe

test("two flanges facing each other along the pipe make a joint", () => {
  const joints = boltedJoints([bar(100, 100, ACROSS), bar(140, 100, ACROSS)]);
  assert.deepEqual(joints, [{ x: 120, y: 100 }]);
});

test("two flanges side by side on different pipes do not", () => {
  // Same size, parallel, close -- but offset ALONG their faces rather than
  // across them, so they are two pipes' fittings, not one bolted joint. This is
  // sheet 1's pair of 15mm vent branches, which invented a third cut.
  assert.deepEqual(boltedJoints([bar(100, 100, ACROSS), bar(100, 140, ACROSS)]), []);
});

test("a lone flange is not a joint", () => {
  // A tie-in at the edge of the sheet: the line continues onto another drawing,
  // so only one side of the bolted joint is actually drawn here.
  assert.deepEqual(boltedJoints([bar(100, 100, ACROSS)]), []);
});

test("flanges of unlike size are not bolted to each other", () => {
  assert.deepEqual(boltedJoints([bar(100, 100, ACROSS, 20), bar(140, 100, ACROSS, 40)]), []);
});

test("flanges too far apart to be bolted are not a joint", () => {
  assert.deepEqual(boltedJoints([bar(100, 100, ACROSS), bar(400, 100, ACROSS)]), []);
});

// --- Which welds flank a joint ---------------------------------------------
test("the flanking welds are one per side, not the two nearest", () => {
  // Weld 1 at 10pt and weld 2 at 12pt sit on the SAME side; the real partner is
  // weld 3 on the other. Taking the two nearest overall put one of sheet 2's
  // cuts three welds early.
  const positions = [
    { x: 90, y: 100 },  // 0: left, 10pt
    { x: 88, y: 100 },  // 1: left, 12pt
    { x: 120, y: 100 }, // 2: right, 20pt
  ];
  assert.deepEqual(flankingWelds({ x: 100, y: 100 }, positions), [0, 2]);
});

test("a joint with a weld on only one side flanks nothing", () => {
  // A branch valve backed by a BLIND flange, which is bolted on rather than
  // welded -- so there is no weld beyond it. Correctly not a spool boundary.
  assert.equal(flankingWelds({ x: 100, y: 100 }, [{ x: 90, y: 100 }, { x: 88, y: 102 }]), null);
});

test("a weld beyond the flanking radius is not counted as a side", () => {
  assert.equal(flankingWelds({ x: 100, y: 100 }, [{ x: 90, y: 100 }, { x: 400, y: 100 }]), null);
});
