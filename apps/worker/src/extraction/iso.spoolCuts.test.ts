import test from "node:test";
import assert from "node:assert/strict";
import { assignSpools, type WeldRow } from "./isoSpoolCuts";

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
