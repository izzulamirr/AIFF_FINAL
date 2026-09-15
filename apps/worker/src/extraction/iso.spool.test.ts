// Offline checks for the deterministic half of ISO spool extraction -- the
// part that turns a sheet read into spools, and the part that judges whether a
// read is good enough to accept. No API calls: every case here feeds a payload
// in by hand and asserts what comes out, so the rules stay pinned without
// paying for a vision run.
//
//   pnpm --filter @easy/worker test:spools
//
// The expected groupings are the hand-verified reading of the reference ISO
// `8"-22-214-01-CRD-0002-AC03N-N`, walked weld-by-weld against the drawing.
// See CLAUDE.md for the boundary rules these encode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpoolsFromWeldTopology } from "@easy/shared";
import { resolveBoundaryWelds, buildWeldTopology, readSpoolTags, spoolProblems } from "./iso";

type Weld = { weld_no: string; weld_type?: string; size?: string; comes_after_weld?: string; closes_spool?: boolean };

// Shorthand for a weld: "<no> <type> after <prev>", optionally at a bore other
// than the run's (which is what marks it as sitting on a branch).
const w = (no: number, type: string, after: number | null, size = "200"): Weld => ({
  weld_no: String(no),
  weld_type: type,
  size,
  comes_after_weld: after == null ? "" : String(after),
});

/** Runs the same deterministic chain the worker runs, and returns tag -> weld numbers. */
function resolve(welds: Weld[], boundaries: Array<{ after_weld: string }> | undefined, tags: string[]) {
  const boundaryWelds = resolveBoundaryWelds(welds, boundaries);
  const topology = buildWeldTopology(welds, boundaryWelds);
  const { spools } = buildSpoolsFromWeldTopology(topology, readSpoolTags(tags));
  return Object.fromEntries(spools.map((s) => [s.spoolTag, s.weldNumbers]));
}

const at = (...welds: number[]) => welds.map((n) => ({ after_weld: String(n) }));

test("sheet 1: branches ride along, and a field weld closes the spool it ends", () => {
  // Real topology as read off the drawing: welds 19 and 20 are branch
  // takeoffs (19 after 16, 20 after 15), and weld 12 is the field weld.
  const welds = [
    w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2), w(4, "TW", 3), w(5, "BW", 4), w(6, "BW", 5),
    w(7, "BW", 6), w(8, "BW", 7), w(9, "BW", 8), w(10, "BW", 9), w(11, "BW", 10), w(12, "FW", 11),
    w(13, "BW", 12), w(14, "BW", 13), w(15, "BW", 14), w(16, "TW", 15), w(17, "BW", 16), w(18, "SW", 17),
    w(19, "BW", 16), w(20, "TW", 15), w(21, "SW", 20), w(22, "BW", 19), w(23, "BW", 22), w(24, "TH", 23),
    w(25, "TH", 24),
  ];
  assert.deepEqual(resolve(welds, at(6, 12), ["N-01", "N-02", "N-03"]), {
    "N-01": [1, 2, 3, 4, 5, 6],
    "N-02": [7, 8, 9, 10, 11, 12],
    "N-03": [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
  });
});

test("sheet 2: a branch taking off AT the closing weld stays in the spool that closes", () => {
  // This is the case that was wrong before: weld 4 closes the spool, and welds
  // 5-6 are a 15mm drain branch hanging off that same weld 4. The branch
  // belongs to N-04; only the main run (weld 7) starts N-05. Likewise the
  // 80mm branch 9-11 hanging off weld 8 stays in N-05, and weld 12 -- the main
  // run, also off weld 8 -- opens N-06.
  const welds = [
    w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2), w(4, "BW", 3),
    w(5, "BW", 4, "15"), w(6, "TH", 5, "15"), // drain branch off weld 4, dead-ends at 6
    w(7, "BW", 4), w(8, "BW", 7), // main run continues
    w(9, "TW", 8), w(10, "BW", 9, "80"), w(11, "BW", 10, "80"), // drain branch off weld 8
    w(12, "BW", 8), w(13, "BW", 12), w(14, "BW", 13), // main run continues past the valve at 8
  ];
  assert.deepEqual(resolve(welds, at(4, 8), ["N-04", "N-05", "N-06"]), {
    "N-04": [1, 2, 3, 4, 5, 6],
    "N-05": [7, 8, 9, 10, 11],
    "N-06": [12, 13, 14],
  });
});

test("the main run is picked by bore, even when a branch outlasts it", () => {
  // Subtree size alone gets this wrong: the 80mm branch off weld 2 is longer
  // than what remains of the 200mm run, so the branch would be mistaken for
  // the continuation and the run's own tail would be swallowed into it.
  const welds = [
    w(1, "BW", null), w(2, "BW", 1),
    w(3, "BW", 2, "80"), w(4, "BW", 3, "80"), w(5, "BW", 4, "80"), w(6, "BW", 5, "80"), // long branch
    w(7, "BW", 2), w(8, "BW", 7), // short main-run tail
  ];
  assert.deepEqual(resolve(welds, at(2), ["A", "B"]), {
    A: [1, 2, 3, 4, 5, 6],
    B: [7, 8],
  });
});

test("an unsized weld list still resolves on subtree size alone", () => {
  const welds: Weld[] = [
    { weld_no: "1", weld_type: "BW", comes_after_weld: "" },
    { weld_no: "2", weld_type: "BW", comes_after_weld: "1" },
    { weld_no: "3", weld_type: "TH", comes_after_weld: "2" }, // branch dead end
    { weld_no: "4", weld_type: "BW", comes_after_weld: "2" },
    { weld_no: "5", weld_type: "BW", comes_after_weld: "4" },
  ];
  assert.deepEqual(resolve(welds, at(2), ["A", "B"]), { A: [1, 2, 3], B: [4, 5] });
});

test("sheet 4: back-to-back field welds leave a one-weld spool between them", () => {
  const welds = [
    w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2), w(4, "BW", 3), w(5, "BW", 4),
    w(6, "FW", 5), w(7, "FW", 6),
    w(8, "BW", 7), w(9, "BW", 8), w(10, "BW", 9), w(11, "BW", 10), w(12, "BW", 11),
    w(13, "BW", 12), w(14, "BW", 13), w(15, "BW", 14), w(16, "BW", 15),
  ];
  assert.deepEqual(resolve(welds, at(6, 7), ["N-12", "N-13", "N-14"]), {
    "N-12": [1, 2, 3, 4, 5, 6],
    "N-13": [7],
    "N-14": [8, 9, 10, 11, 12, 13, 14, 15, 16],
  });
});

test("a field weld closes its spool even when the model marked nothing", () => {
  const welds = [w(1, "BW", null), w(2, "BW", 1), w(3, "FW", 2), w(4, "BW", 3), w(5, "BW", 4)];
  assert.deepEqual(resolve(welds, [], ["A", "B"]), { A: [1, 2, 3], B: [4, 5] });
});

test("per-weld closes_spool is the fallback when no boundary list came back", () => {
  const welds: Weld[] = [
    { weld_no: "1", weld_type: "BW", comes_after_weld: "" },
    { weld_no: "2", weld_type: "BW", comes_after_weld: "1", closes_spool: true },
    { weld_no: "3", weld_type: "BW", comes_after_weld: "2" },
  ];
  assert.deepEqual(resolve(welds, undefined, ["A", "B"]), { A: [1, 2], B: [3] });
});

test("the boundary list wins over stale per-weld flags", () => {
  const welds: Weld[] = [
    { weld_no: "1", weld_type: "BW", comes_after_weld: "" },
    { weld_no: "2", weld_type: "BW", comes_after_weld: "1", closes_spool: true }, // disagrees
    { weld_no: "3", weld_type: "BW", comes_after_weld: "2" },
    { weld_no: "4", weld_type: "BW", comes_after_weld: "3" },
  ];
  assert.deepEqual(resolve(welds, at(3), ["A", "B"]), { A: [1, 2, 3], B: [4] });
});

test("spool_tags survives the object shape real runs drift to", () => {
  assert.deepEqual(readSpoolTags(["A-01", "A-02"]), ["A-01", "A-02"]);
  assert.deepEqual(readSpoolTags([{ spool_tag: "A-01" }, { spool_tag: "A-02" }] as never), ["A-01", "A-02"]);
  assert.deepEqual(readSpoolTags(undefined), []);
});

// --- the checks that decide whether a read is accepted or retried -----------

const cleanRead = {
  line_number: "L1",
  bom_items: [],
  spool_tags: ["N-01", "N-02", "N-03"],
  spool_boundaries: [
    { after_weld: "4", boundary_type: "valve", evidence: "PT NO 7, 200mm BALL VALVE flanged both sides, between welds 4 and 5" },
    { after_weld: "9", boundary_type: "field_weld", evidence: "weld 9 carries the hatched FW tick; 6200mm run" },
  ],
  welds: [
    w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2), w(4, "BW", 3), w(5, "BW", 4),
    w(6, "BW", 5), w(7, "BW", 6), w(8, "BW", 7), w(9, "FW", 8), w(10, "BW", 9),
  ],
};

test("a clean read raises nothing", () => {
  assert.deepEqual(spoolProblems(cleanRead), []);
});

test("the printed spool count fixes the number of cuts", () => {
  const problems = spoolProblems({ ...cleanRead, spool_boundaries: cleanRead.spool_boundaries.slice(0, 1) });
  assert.equal(problems.length, 2); // wrong count, and the FW no longer covered
  assert.match(problems[0], /3 spool tags .* exactly 2 boundaries -- but you gave 1/);
});

test("a field weld that is not a boundary is caught", () => {
  const problems = spoolProblems({ ...cleanRead, spool_boundaries: at(4, 8).map((b) => ({ ...b, boundary_type: "valve", evidence: "a valve" })) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /weld 9 is typed FW/);
});

test("evenly spaced boundaries are rejected as guessing, not reading", () => {
  // The exact failure recorded on sheet 2 of the reference ISO: 26 welds, 6
  // spools, boundaries landing every 4th weld.
  const welds = Array.from({ length: 26 }, (_, i) => w(i + 1, "BW", i === 0 ? null : i));
  const problems = spoolProblems({
    line_number: "L1",
    bom_items: [],
    spool_tags: ["N-04", "N-05", "N-06", "N-07", "N-08", "N-09"],
    spool_boundaries: at(4, 8, 12, 16, 20).map((b) => ({ ...b, boundary_type: "valve", evidence: "a valve here" })),
    welds,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /exactly 4 apart every time/);
});

test("uneven boundaries at the same count are accepted", () => {
  const welds = Array.from({ length: 26 }, (_, i) => w(i + 1, "BW", i === 0 ? null : i));
  const problems = spoolProblems({
    line_number: "L1",
    bom_items: [],
    spool_tags: ["N-04", "N-05", "N-06", "N-07", "N-08", "N-09"],
    spool_boundaries: at(6, 11, 14, 17, 22).map((b) => ({ ...b, boundary_type: "valve", evidence: "a valve here" })),
    welds,
  });
  assert.deepEqual(problems, []);
});

test("a valve boundary that cannot name its valve is caught", () => {
  const problems = spoolProblems({
    ...cleanRead,
    spool_boundaries: [
      { after_weld: "4", boundary_type: "valve", evidence: "boundary between spools" },
      { after_weld: "9", boundary_type: "field_weld", evidence: "hatched FW tick at weld 9" },
    ],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /evidence does not name a valve/);
});

test("dangling welds are caught", () => {
  const problems = spoolProblems({
    ...cleanRead,
    welds: [w(1, "BW", null), w(2, "BW", null), w(3, "BW", null), w(4, "BW", 3), w(9, "FW", 4)],
  });
  assert.ok(problems.some((p) => /left comes_after_weld blank on 3/.test(p)));
});

// --- generality: none of the above may depend on the reference drawing ------
//
// The rules are meant to come from how isometrics work, not from one drawing,
// so these cases deliberately look nothing like the reference ISO: different
// tag conventions, imperial bores, no field welds, no branches, nested
// branches, and weld numbering that is neither contiguous nor in run order.

test("tag convention is whatever the sheet prints", () => {
  const welds = [w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2), w(4, "BW", 3)];
  assert.deepEqual(resolve(welds, at(2), ["SP-1", "SP-2"]), { "SP-1": [1, 2], "SP-2": [3, 4] });
  assert.deepEqual(resolve(welds, at(2), ["P-1010-SPOOL-A", "P-1010-SPOOL-B"]), {
    "P-1010-SPOOL-A": [1, 2],
    "P-1010-SPOOL-B": [3, 4],
  });
});

test("bores in inches discriminate branches just as well as millimetres", () => {
  const welds = [
    w(1, "BW", null, '6"'), w(2, "BW", 1, '6"'),
    w(3, "TW", 2, '1"'), w(4, "TH", 3, '1"'), // small-bore branch off weld 2
    w(5, "BW", 2, '6"'), w(6, "BW", 5, '6"'),
  ];
  assert.deepEqual(resolve(welds, at(2), ["A", "B"]), { A: [1, 2, 3, 4], B: [5, 6] });
});

test("a sheet with no field welds and no branches is just a chain of cuts", () => {
  const welds = [w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2), w(4, "BW", 3), w(5, "BW", 4), w(6, "BW", 5)];
  assert.deepEqual(resolve(welds, at(1, 3, 5), ["A", "B", "C", "D"]), {
    A: [1],
    B: [2, 3],
    C: [4, 5],
    D: [6],
  });
});

test("a branch hanging off a branch still rides along", () => {
  const welds = [
    w(1, "BW", null), w(2, "BW", 1),
    w(3, "TW", 2, "50"), w(4, "BW", 3, "50"), // branch off the run
    w(5, "TW", 4, "25"), w(6, "TH", 5, "25"), // sub-branch off that branch
    w(7, "BW", 2), w(8, "BW", 7),
  ];
  assert.deepEqual(resolve(welds, at(2), ["A", "B"]), { A: [1, 2, 3, 4, 5, 6], B: [7, 8] });
});

test("weld numbering need not be contiguous or in run order", () => {
  // Branch takeoffs are commonly numbered out of sequence with where they sit.
  const welds = [
    w(101, "BW", null), w(205, "BW", 101), w(102, "BW", 205), w(103, "BW", 102),
  ];
  assert.deepEqual(resolve(welds, at(205), ["A", "B"]), { A: [101, 205], B: [102, 103] });
});

test("more spools than printed tags falls back to synthetic tags rather than dropping welds", () => {
  const welds = [w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2), w(4, "BW", 3)];
  const out = resolve(welds, at(1, 2, 3), ["A", "B"]);
  assert.deepEqual(Object.values(out).flat().sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(Object.keys(out).length, 4);
});

test("back-to-back field welds at a regular spacing are not mistaken for guessing", () => {
  // Four forced cuts in a row is what a long straight run actually looks like;
  // the even-spacing check must not fire on field welds.
  const problems = spoolProblems({
    line_number: "L1",
    bom_items: [],
    spool_tags: ["A", "B", "C", "D", "E"],
    spool_boundaries: [6, 7, 8, 9].map((no) => ({
      after_weld: String(no),
      boundary_type: "field_weld",
      evidence: `weld ${no} carries the hatched FW tick`,
    })),
    welds: [
      w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2), w(4, "BW", 3), w(5, "BW", 4),
      w(6, "FW", 5), w(7, "FW", 6), w(8, "FW", 7), w(9, "FW", 8), w(10, "BW", 9),
    ],
  });
  assert.deepEqual(problems, []);
});

test("a sheet that prints no spool schedule is not forced into a boundary count", () => {
  const problems = spoolProblems({
    line_number: "L1",
    bom_items: [],
    spool_tags: [],
    spool_boundaries: [{ after_weld: "2", boundary_type: "valve", evidence: "PT NO 4, gate valve flanged both sides" }],
    welds: [w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2)],
  });
  assert.deepEqual(problems, []);
});

test("a boundary pointing at a weld the sheet does not have is caught", () => {
  const problems = spoolProblems({
    ...cleanRead,
    spool_boundaries: [
      { after_weld: "4", boundary_type: "valve", evidence: "a valve" },
      { after_weld: "99", boundary_type: "valve", evidence: "a valve" },
    ],
  });
  assert.ok(problems.some((p) => /points at weld 99/.test(p)));
});
