// Which drawing of a line is in force.
//
// Every case here is about the same risk running one way: superseding a drawing
// HIDES its spools, welds and BOM from every page that filters by line. An
// over-eager rule loses real material off the job; an under-eager one shows an
// extra drawing that is plainly labelled. So the tests mostly check that the
// rule REFUSES, and only orders where the drawings say so themselves.
import test from "node:test";
import assert from "node:assert/strict";
import { compareRevisions, needsRecheck, normalizeRevision, resolveRevisions } from "@easy/shared";

const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const doc = (documentId: string, revision: string | null, d = 1) => ({ documentId, revision, uploadedAt: day(d) });
const ids = (list: Array<{ documentId: string }>) => list.map((x) => x.documentId).sort();

test("a title block's decoration is not part of the revision", () => {
  assert.equal(normalizeRevision("REV 1"), "1");
  assert.equal(normalizeRevision("Rev. 1"), "1");
  assert.equal(normalizeRevision("  1 "), "1");
  assert.equal(normalizeRevision("revision: A"), "A");
});

test("a blank, a dash and an N/A are no revision at all", () => {
  for (const raw of ["", "   ", "-", "--", "N/A", "NA", null, undefined]) {
    assert.equal(normalizeRevision(raw), null, `expected no revision for ${JSON.stringify(raw)}`);
  }
});

test("numeric revisions order as numbers, not as text", () => {
  // The bug this pins: "10" < "9" as a string, which would put rev 10 behind
  // rev 9 and supersede the current drawing with an old one.
  assert.ok(compareRevisions("10", "9")! > 0);
  assert.ok(compareRevisions("0", "1")! < 0);
  assert.equal(compareRevisions("2", "2"), 0);
});

test("alpha revisions order A, B ... Z, AA", () => {
  assert.ok(compareRevisions("B", "A")! > 0);
  assert.ok(compareRevisions("AA", "Z")! > 0);
  assert.equal(compareRevisions("C", "C"), 0);
});

test("a letter against a number cannot be ordered, and says so", () => {
  // Some offices issue A before 0 and some after. Guessing either way would
  // hide a current drawing, so the answer is null and the caller shows both.
  assert.equal(compareRevisions("A", "0"), null);
  assert.equal(compareRevisions("1", "B"), null);
  assert.equal(compareRevisions("0A", "1"), null);
});

test("an unread REV box is never ordered against anything", () => {
  assert.equal(compareRevisions(null, "1"), null);
  assert.equal(compareRevisions("1", ""), null);
});

test("the highest printed revision is current and the rest are superseded", () => {
  const r = resolveRevisions([doc("old", "0", 1), doc("new", "1", 2)]);
  assert.deepEqual(ids(r.current), ["new"]);
  assert.deepEqual(ids(r.superseded), ["old"]);
  assert.equal(r.revision, "1");
  assert.equal(r.decidedBy, "the printed revision");
});

test("uploading an OLD drawing later does not promote it", () => {
  // The whole reason the printed revision beats upload order: rev 0 arriving
  // after rev 1 is a mistake, not a new issue.
  const r = resolveRevisions([doc("new", "1", 1), doc("stale", "0", 9)]);
  assert.deepEqual(ids(r.current), ["new"]);
  assert.deepEqual(ids(r.superseded), ["stale"]);
  assert.equal(r.revision, "1");
});

test("two drawings at the SAME revision are both current", () => {
  // A line carried by a full set beside a partial one. Picking the newer upload
  // would drop half the line's material.
  const r = resolveRevisions([doc("a", "1", 1), doc("b", "1", 2)]);
  assert.deepEqual(ids(r.current), ["a", "b"]);
  assert.deepEqual(r.superseded, []);
  assert.equal(r.revision, "1");
});

test("one drawing is current and its revision is still reported", () => {
  const r = resolveRevisions([doc("only", "2")]);
  assert.deepEqual(ids(r.current), ["only"]);
  assert.equal(r.revision, "2");
  assert.equal(r.decidedBy, "the printed revision");
});

test("ONE unreadable REV box leaves every drawing current", () => {
  // The safe direction. Two drawings, one of them legible, and it would be easy
  // to call that one current -- but the blank might be the later issue.
  const r = resolveRevisions([doc("a", "1", 1), doc("b", null, 2)]);
  assert.deepEqual(ids(r.current), ["a", "b"]);
  assert.deepEqual(r.superseded, []);
  assert.equal(r.revision, null);
  assert.equal(r.decidedBy, null, "an unknown order must be reported as unknown");
});

test("revisions that cannot be ordered leave every drawing current", () => {
  const r = resolveRevisions([doc("a", "A", 1), doc("b", "1", 2)]);
  assert.deepEqual(ids(r.current), ["a", "b"]);
  assert.deepEqual(r.superseded, []);
  assert.equal(r.decidedBy, null);
});

test("no drawings is not an error", () => {
  const r = resolveRevisions([]);
  assert.deepEqual(r.current, []);
  assert.equal(r.revision, null);
});

test("a check calls for a re-check only when the revision is known to have moved", () => {
  assert.equal(needsRecheck("0", "1"), true);
  assert.equal(needsRecheck("1", "1"), false);
  assert.equal(needsRecheck("REV 1", "1"), false, "the same revision spelled two ways is not a change");
});

test("an unknown revision on either side never cries wolf", () => {
  // A review recorded before revisions were tracked, and a drawing whose REV
  // box could not be read. Neither is evidence the drawing changed, and
  // flagging them would put every line on the job into re-check at once.
  assert.equal(needsRecheck(null, "1"), false);
  assert.equal(needsRecheck("0", null), false);
  assert.equal(needsRecheck(null, null), false);
});
