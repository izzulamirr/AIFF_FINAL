// A stud bolt's order size and nut count: the length goes up to the next 5 mm, the diameter is
// as stated, and the nut count is what the admin list's stud lines can actually be matched on.
import test from "node:test";
import assert from "node:assert/strict";
import { formatStudSize, roundUpToFive, studNutCounts, studOrderSize } from "@easy/shared";

test("a length is taken up to the next 5, never down", () => {
  assert.equal(roundUpToFive(89), 90);
  assert.equal(roundUpToFive(102), 105);
  assert.equal(roundUpToFive(108), 110);
  assert.equal(roundUpToFive(172), 175);
  assert.equal(roundUpToFive(242), 245);
  assert.equal(roundUpToFive(61), 65);
});

test("a length already on a multiple of 5 stays", () => {
  assert.equal(roundUpToFive(90), 90);
  assert.equal(roundUpToFive(110), 110);
  assert.equal(roundUpToFive(5), 5);
});

test("the diameter is kept as the BOM states it; only the length changes", () => {
  const order = (s: string) => formatStudSize(studOrderSize(s)!);
  assert.equal(order("16X89"), "16X90");
  assert.equal(order("20X102"), "20X105");
  assert.equal(order("20X108"), "20X110");
  assert.equal(order("24X172"), "24X175");
  assert.equal(order("14X60"), "14X60");
});

test("units, spacing and case are read", () => {
  assert.equal(formatStudSize(studOrderSize("16 x 89 mm")!), "16X90");
  assert.equal(formatStudSize(studOrderSize("16x89")!), "16X90");
  assert.equal(studOrderSize("16X89 mm")?.lengthMm, 89);
});

test("a size that is not diameter x length has no order size", () => {
  assert.equal(studOrderSize("200"), null);
  assert.equal(studOrderSize("200 x 80 x 3"), null);
  assert.equal(studOrderSize(""), null);
  assert.equal(studOrderSize(undefined), null);
});

test("the nut count is read from the description", () => {
  assert.deepEqual(studNutCounts("110 STUD BOLT ASTM A193 B7M, NUTS ASTM A194 2HM, HOT DIP GALVANISED (WITH 2 NUTS)"), [2]);
  assert.deepEqual(studNutCounts("STUD BOLT ..., (WITH 3 NUTS)"), [3]);
  assert.deepEqual(studNutCounts("140 STUD BOLT ... (WITH 2 NUTS) 110 STUD BOLT ... (WITH 3 NUTS)"), [2, 3]);
  assert.deepEqual(studNutCounts("GASKET, SPIRAL WD"), []);
});
