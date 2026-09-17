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
import { resolveBoundaryWelds, buildWeldTopology, readSpoolTags, spoolProblems, weldListProblems, buildIsoTags, boundaryValvesOf, locatedBoundariesOf } from "./iso";

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

test("sheet 2 in full: the dense sheet resolves once the valves are actually found", () => {
  // The sheet the old pipeline did worst on -- 26 welds, 6 spools, three
  // branches. Topology and bores read off the drawing; the five boundaries are
  // its five main-run valves (four 200mm ball valves and the 150mm gate valve
  // in the reduced section), which is exactly the count its PIPE SPOOLS
  // schedule implies. Every branch takes off AT a closing weld, which is the
  // arrangement that used to scatter them into the following spool.
  const welds = [
    w(1, "BW", null), w(2, "BW", 1), w(3, "BW", 2), w(4, "BW", 3),
    w(5, "BW", 4, "15"), w(6, "TH", 5, "15"), //        15mm drain branch off weld 4
    w(7, "BW", 4), w(8, "BW", 7), w(9, "TW", 8),
    w(10, "BW", 9, "80"), w(11, "BW", 10, "80"), //     80mm branch off the weldolet at weld 9
    w(12, "BW", 9), w(13, "BW", 12), w(14, "BW", 13, "150"),
    w(15, "BW", 14, "150"), w(16, "BW", 15), w(17, "BW", 16),
    w(18, "BW", 17), w(19, "BW", 18), w(20, "TW", 19),
    w(21, "BW", 20, "80"), w(22, "BW", 21, "80"), //    80mm branch off the weldolet at weld 20
    w(23, "BW", 20), w(24, "BW", 23), w(25, "BW", 24), w(26, "BW", 25),
  ];
  assert.deepEqual(resolve(welds, at(4, 9, 14, 17, 20), ["N-04", "N-05", "N-06", "N-07", "N-08", "N-09"]), {
    "N-04": [1, 2, 3, 4, 5, 6],
    "N-05": [7, 8, 9, 10, 11],
    "N-06": [12, 13, 14],
    "N-07": [15, 16, 17],
    "N-08": [18, 19, 20, 21, 22],
    "N-09": [23, 24, 25, 26],
  });
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

// --- what the boundary pass actually returned on a real run -----------------

test("a valve's own three observations decide whether it is a boundary", () => {
  // Both of sheet 5's check valves came back on the main run, flanged both
  // sides, with pipe continuing past -- and is_boundary false, contradicting
  // all three. The conclusion is arithmetic, so it is taken here.
  const valves = boundaryValvesOf({
    valves: [
      { description: "200mm CHECK VALVE, DUAL PLATE", on_main_run: true, flanged_both_sides: true, pipe_continues_past: true, is_boundary: false },
      { description: "80mm GATE VALVE", on_main_run: false, flanged_both_sides: true, pipe_continues_past: false, is_boundary: false },
      { description: "200mm BALL VALVE", on_main_run: true, flanged_both_sides: true, pipe_continues_past: true, is_boundary: true },
    ],
  });
  assert.deepEqual(valves.map((v) => v.description), ["200mm CHECK VALVE, DUAL PLATE", "200mm BALL VALVE"]);
});

test("repeated weld numbers across boundaries are not usable", () => {
  // Sheet 2's real answer: four separate ball valves, all reported at weld 14.
  const { weldNumbersUsable } = locatedBoundariesOf({
    valves: [14, 14, 14, 14].map((no) => ({
      description: "200mm BALL VALVE",
      on_main_run: true,
      flanged_both_sides: true,
      pipe_continues_past: true,
      nearest_upstream_weld: String(no),
    })),
    field_welds: [],
  });
  assert.equal(weldNumbersUsable, false);
});

test("distinct weld numbers for every boundary are usable", () => {
  const { located, weldNumbersUsable } = locatedBoundariesOf({
    valves: [4, 9, 14].map((no) => ({
      description: "200mm BALL VALVE",
      on_main_run: true,
      flanged_both_sides: true,
      pipe_continues_past: true,
      nearest_upstream_weld: String(no),
    })),
    field_welds: [{ weld_no: "20", evidence: "hatched FW tick" }],
  });
  assert.equal(weldNumbersUsable, true);
  assert.deepEqual(located.map((b) => b.after_weld), ["4", "9", "14", "20"]);
});

test("a boundary left unplaced makes the whole set unusable", () => {
  const { weldNumbersUsable } = locatedBoundariesOf({
    valves: [
      { description: "v1", on_main_run: true, flanged_both_sides: true, pipe_continues_past: true, nearest_upstream_weld: "4" },
      { description: "v2", on_main_run: true, flanged_both_sides: true, pipe_continues_past: true, nearest_upstream_weld: "" },
    ],
    field_welds: [],
  });
  assert.equal(weldNumbersUsable, false);
});

test("two boundaries at the same weld is caught as impossible", () => {
  const problems = spoolProblems({
    ...cleanRead,
    spool_boundaries: [
      { after_weld: "4", boundary_type: "valve", evidence: "PT NO 14, ball valve" },
      { after_weld: "4", boundary_type: "valve", evidence: "PT NO 14, ball valve" },
      { after_weld: "9", boundary_type: "field_weld", evidence: "hatched FW tick" },
    ],
  });
  assert.ok(problems.some((p) => /more than one boundary is recorded at weld 4/.test(p)));
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

// ---------------------------------------------------------------------------
// THE WELD LIST, CHECKED AGAINST THE DRAWING
//
// Weld detection off the geometry is exact -- 92 flags against 92 hand-verified
// welds across the reference ISO -- and the contact-sheet numbering is only
// accepted when it comes back a complete, unduplicated 1..N. That gives a known
// right answer for which weld IDs a sheet has, so the model's weld list can be
// checked against the drawing instead of only against itself. This is the check
// that replaces the boundary complaints on a sheet the geometry resolved: the
// boundaries are no longer the model's to get wrong, but the weld TYPE still is,
// and the type is the one input geometry cannot supply.

const drawn = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const asWelds = (nos: number[]) => ({ welds: nos.map((no) => ({ weld_no: String(no) })) }) as never;

test("a weld list matching the drawn flags raises nothing", () => {
  assert.deepEqual(weldListProblems(asWelds(drawn(16)), drawn(16)), []);
});

test("a weld reported twice is caught -- vision has done exactly this", () => {
  // A real run reported weld 1 twice on sheet 4 and returned 17 rows for 16
  // welds, reading one mark from each of two overlapping tiles.
  const problems = weldListProblems(asWelds([1, 1, ...drawn(16).slice(1)]), drawn(16));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /weld 1 more than once/);
});

test("a weld number that is on no flag is caught as invented", () => {
  // The square BOM item balloon read as a weld -- the failure per-valve crops
  // produced repeatedly.
  const problems = weldListProblems(asWelds([...drawn(16), 42]), drawn(16));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /weld 42/);
});

test("a weld the drawing has and the read missed is named", () => {
  const problems = weldListProblems(asWelds(drawn(16).filter((n) => n !== 9)), drawn(16));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /weld 9 is missing/);
});

test("with no flags read there is nothing to check against, so nothing is claimed", () => {
  // The geometry is an improvement on a pipeline that already works: where it
  // has no answer it must not manufacture a complaint.
  assert.deepEqual(weldListProblems(asWelds(drawn(16)), []), []);
});

// ---------------------------------------------------------------------------
// THE DRAWING'S SPOOLS REACH THE TAG ROWS
//
// The geometry has been right for a while; what it could not do was survive an
// extraction. Every re-run deleted the rows a script had corrected, so the good
// answer lived in the database and never in the pipeline. These pin the wiring:
// where the drawing resolved a sheet, its answer is what gets stored.

const sheetOf = (
  welds: Array<[number, string]>,
  spoolTags: string[],
  /** What the VISION pass said, for the cases where it still has to answer. */
  vision?: { comesAfter?: Record<number, number>; boundaries?: Array<{ after_weld: string; boundary_type: string; evidence: string }> }
) => ({
  drawing_number: "ISO-1",
  pageNumber: 1,
  result: {
    line_number: '8"-22-214-01-CRD-0002-AC03N-N',
    spool_tags: spoolTags,
    spool_boundaries: vision?.boundaries ?? [],
    welds: welds.map(([no, type]) => ({
      weld_no: String(no),
      weld_type: type,
      size: "200",
      comes_after_weld: vision?.comesAfter?.[no] != null ? String(vision.comesAfter[no]) : undefined,
    })),
    bom_items: [],
  },
});

const geoPage = (cuts: number[], assignment: Record<string, string>, tagOrder: string[]) => ({
  page: 1,
  cuts,
  trusted: true,
  evidence: cuts.map((c) => ({ cut: c, why: `ends after weld ${c}, at the bolted joint` })),
  assignment,
  tagOrder,
  tagChanges: [],
});

const spoolRows = (tags: ReturnType<typeof buildIsoTags>) =>
  Object.fromEntries(tags.filter((t) => t.tagType === "spool").map((t) => [t.tagNumber, t.attributes.weld_numbers]));

test("where the drawing resolved a sheet, its spools are what get stored", () => {
  const sheet = sheetOf([[1, "BW"], [2, "BW"], [3, "BW"], [4, "BW"]], ["N-01", "N-02"]);
  // The vision walk has no comes_after_weld at all here, so on its own it
  // would place nothing. The drawing cuts after weld 2.
  const geo = geoPage([2], { 1: "N-01", 2: "N-01", 3: "N-02", 4: "N-02" }, ["N-01", "N-02"]);
  assert.deepEqual(spoolRows(buildIsoTags([sheet] as never, [geo] as never)), {
    "N-01": [1, 2],
    "N-02": [3, 4],
  });
});

test("every weld on a resolved sheet carries its spool, none left blank", () => {
  const sheet = sheetOf([[1, "BW"], [2, "BW"], [3, "BW"], [4, "BW"]], ["N-01", "N-02"]);
  const geo = geoPage([2], { 1: "N-01", 2: "N-01", 3: "N-02", 4: "N-02" }, ["N-01", "N-02"]);
  const welds = buildIsoTags([sheet] as never, [geo] as never).filter((t) => t.tagType === "weld");
  assert.equal(welds.length, 4);
  assert.equal(welds.filter((w) => !w.attributes.spool_no).length, 0);
});

test("a spool row is never invented -- every tag comes off the printed schedule", () => {
  // buildSpoolsFromWeldTopology mints `spool-<n>` when the walk finds more
  // spools than the sheet printed tags, which put a row in the database
  // claiming welds a real spool also claimed. The blocks here come FROM the
  // printed tags, so there is nothing to invent.
  const sheet = sheetOf([[1, "BW"], [2, "BW"], [3, "BW"]], ["N-01", "N-02"]);
  const geo = geoPage([1], { 1: "N-01", 2: "N-02", 3: "N-02" }, ["N-01", "N-02"]);
  const tags = buildIsoTags([sheet] as never, [geo] as never);
  assert.equal(tags.filter((t) => t.tagType === "spool" && /^spool-/.test(t.tagNumber)).length, 0);
});

test("a spool row says it came from the drawing, and why it ends where it does", () => {
  const sheet = sheetOf([[1, "BW"], [2, "BW"], [3, "BW"]], ["N-01", "N-02"]);
  const geo = geoPage([1], { 1: "N-01", 2: "N-02", 3: "N-02" }, ["N-01", "N-02"]);
  const first = buildIsoTags([sheet] as never, [geo] as never).find((t) => t.tagType === "spool");
  assert.equal(first?.attributes.from_drawing, true);
  assert.match(String(first?.attributes.note), /bolted joint/);
});

test("a sheet the drawing REFUSED keeps the vision answer untouched", () => {
  // The count check refusing is the safe outcome, not a failure: a wrong cut
  // puts welds in the wrong spool, which is worse than leaving them.
  const sheet = sheetOf([[1, "BW"], [2, "BW"], [3, "BW"]], ["N-01", "N-02"], {
    comesAfter: { 2: 1, 3: 2 },
    boundaries: [{ after_weld: "2", boundary_type: "valve", evidence: "PT NO 7 ball valve" }],
  });
  const refused = { ...geoPage([], {}, ["N-01", "N-02"]), trusted: false, why: "0 cuts for 2 printed tags" };
  assert.deepEqual(spoolRows(buildIsoTags([sheet] as never, [refused] as never)), {
    "N-01": [1, 2],
    "N-02": [3],
  });
});

test("a payload saved before the geometry existed rebuilds exactly as it did", () => {
  const sheet = sheetOf([[1, "BW"], [2, "BW"], [3, "BW"]], ["N-01", "N-02"], {
    comesAfter: { 2: 1, 3: 2 },
    boundaries: [{ after_weld: "2", boundary_type: "valve", evidence: "PT NO 7 ball valve" }],
  });
  assert.deepEqual(spoolRows(buildIsoTags([sheet] as never)), { "N-01": [1, 2], "N-02": [3] });
});
