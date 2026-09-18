// A spool number must name ONE piece of pipe.
//
// The case these come from is real and it is the kind a sheet-by-sheet read
// never catches: a revision added a spool to sheet 4, its printed tags went
// from four to five, and sheet 5's were not renumbered to follow. N-15 then
// named both sheet 4's welds 9-12 and sheet 5's welds 1-5. Each sheet looks
// perfectly tidy on its own.
import test from "node:test";
import assert from "node:assert/strict";
import { spoolTagClashes } from "@easy/shared";

const b = (page: number, spool: string, weldNumbers: number[]) => ({ page, spool, weldNumbers });

test("a spool carrying onto the next sheet is not a clash", () => {
  // It leaves at the END of sheet 4 and arrives at the START of sheet 5.
  const blocks = [
    b(4, "N-15", [9, 10, 11, 12]),
    b(4, "N-16", [13, 14, 15, 16, 17]),
    b(5, "N-16", [1, 2, 3, 4, 5]),
    b(5, "N-17", [6, 7, 8, 9, 10]),
  ];
  assert.deepEqual(spoolTagClashes(blocks), []);
});

test("the same number on two pieces that are NOT a continuation is caught", () => {
  // Sheet 5 not renumbered after sheet 4 gained a spool: N-15 is sheet 4's
  // second-to-last block AND sheet 5's first.
  const blocks = [
    b(4, "N-15", [9, 10, 11, 12]),
    b(4, "N-16", [13, 14, 15, 16, 17]),
    b(5, "N-15", [1, 2, 3, 4, 5]),
    b(5, "N-16", [6, 7, 8, 9, 10]),
  ];
  const found = spoolTagClashes(blocks);
  assert.deepEqual(found.map((f) => f.spool), ["N-15", "N-16"]);
  assert.match(found[0].why, /not the last spool/);
  assert.match(found[1].why, /not the first spool/);
});

test("one number on two blocks of the SAME sheet is caught", () => {
  const found = spoolTagClashes([b(2, "N-04", [1, 2, 3]), b(2, "N-04", [9, 10]), b(2, "N-05", [4, 5])]);
  assert.equal(found.length, 1);
  assert.match(found[0].why, /separate blocks on sheet 2/);
});

test("the same number on sheets that do not run on is caught", () => {
  const found = spoolTagClashes([b(1, "N-01", [1, 2]), b(3, "N-01", [1, 2])]);
  assert.equal(found.length, 1);
  assert.match(found[0].why, /do not run on/);
});

test("a spool crossing a whole middle sheet is allowed", () => {
  const blocks = [b(1, "N-01", [5, 6]), b(2, "N-01", [1, 2, 3]), b(3, "N-01", [1, 2]), b(3, "N-02", [3, 4])];
  assert.deepEqual(spoolTagClashes(blocks), []);
});

test("a spool on one sheet only is never a clash", () => {
  assert.deepEqual(spoolTagClashes([b(1, "N-01", [1, 2]), b(1, "N-02", [3, 4])]), []);
});
