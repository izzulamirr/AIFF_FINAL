import test from "node:test";
import assert from "node:assert/strict";
import { blockOfLeader, tagsByBlock } from "./isoSpoolTags";

test("a leader between welds either side of a cut names the LATER block", () => {
  // Sheet 4: cut at weld 6, and the 6000mm piece runs from weld 6 to weld 7.
  // A field weld closes the spool it ends, so that piece starts the next one.
  assert.equal(blockOfLeader([6, 7], [6, 7]), 1);
  assert.equal(blockOfLeader([5, 6], [6, 7]), 0);
  assert.equal(blockOfLeader([13, 14], [6, 7]), 2);
});

test("a leader with no flanking pair names no block", () => {
  assert.equal(blockOfLeader(null, [6, 7]), null);
});

test("tags are re-ordered onto the blocks their leaders point at", () => {
  // The real sheet 4 case: N-14's leader is on the middle block.
  const fallback = ["N-12", "N-13", "N-14"];
  const got = tagsByBlock(
    [
      { tag: "N-13", block: 2 },
      { tag: "N-14", block: 1 },
      { tag: "N-12", block: 0 },
    ],
    fallback
  );
  assert.deepEqual(got.tags, ["N-12", "N-14", "N-13"]);
  assert.deepEqual(got.changed, [
    { block: 1, from: "N-13", to: "N-14" },
    { block: 2, from: "N-14", to: "N-13" },
  ]);
});

test("where the drawing agrees with sorted order, nothing changes", () => {
  const fallback = ["N-01", "N-02", "N-03"];
  const got = tagsByBlock(
    [
      { tag: "N-01", block: 0 },
      { tag: "N-02", block: 1 },
      { tag: "N-03", block: 2 },
    ],
    fallback
  );
  assert.deepEqual(got.tags, fallback);
  assert.deepEqual(got.changed, []);
});

test("an unread tag leaves its block on the sorted-order answer", () => {
  const fallback = ["N-10", "N-11"];
  const got = tagsByBlock([{ tag: "N-10", block: 0 }], fallback);
  assert.deepEqual(got.tags, ["N-10", "N-11"]);
});

test("a reading that does not use each tag once is REFUSED", () => {
  const fallback = ["N-12", "N-13", "N-14"];
  // N-14 read into two blocks: a leader was followed somewhere wrong.
  const got = tagsByBlock(
    [
      { tag: "N-14", block: 0 },
      { tag: "N-14", block: 1 },
    ],
    fallback
  );
  assert.deepEqual(got.tags, fallback, "keeps the answer that at least uses each tag once");
  assert.match(got.why ?? "", /exactly once/);
});

test("two tags claiming one block is refused rather than resolved", () => {
  const fallback = ["N-12", "N-13"];
  const got = tagsByBlock(
    [
      { tag: "N-12", block: 0 },
      { tag: "N-13", block: 0 },
    ],
    fallback
  );
  assert.deepEqual(got.tags, fallback);
  assert.match(got.why ?? "", /two tags point at block 0/);
});

test("a leader pointing outside the sheet's blocks is refused", () => {
  const fallback = ["N-12", "N-13"];
  const got = tagsByBlock([{ tag: "N-12", block: 5 }], fallback);
  assert.deepEqual(got.tags, fallback);
  assert.match(got.why ?? "", /outside/);
});
