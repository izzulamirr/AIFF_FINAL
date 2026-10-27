// Comparing two P&ID readings. The risk runs both ways: a missed change is a
// revision nobody checks, and a reported non-change -- two readings of the same
// drawing differing in case or spacing -- buries the real ones. So the tests pin
// what must NOT be reported as hard as what must.
import test from "node:test";
import assert from "node:assert/strict";
import { comparePids, type CompareTag } from "@easy/shared";

const SHEET = "PID-0010";
const line = (n: string, a: Record<string, unknown> = {}): CompareTag => ({
  tagType: "line",
  tagNumber: n,
  sourcePage: 1,
  attributes: { sheet_number: SHEET, size: '8"', spec_class: "AC03N", from_equipment: "V-100", to_equipment: "V-102", ...a },
});
const valve = (tag: string, a: Record<string, unknown> = {}): CompareTag => ({
  tagType: "valve",
  tagNumber: tag,
  sourcePage: 1,
  attributes: { sheet_number: SHEET, valve_type: "control valve", line_number: "L-1", size: '6"', spec_class: "AC03N", ...a },
});
const handValve = (a: Record<string, unknown> = {}): CompareTag => ({
  tagType: "valve",
  tagNumber: "ball valve",
  sourcePage: 1,
  attributes: { sheet_number: SHEET, valve_type: "ball valve", line_number: "L-1", size: '2"', spec_class: "AC03N", untagged: true, quantity: "1", ...a },
});

test("two identical readings report nothing", () => {
  const tags = [line("L-1"), valve("PCV-1"), handValve()];
  const r = comparePids(tags, tags);
  assert.equal(r.lines.length + r.tagged.length + r.counts.length + r.renumbered.length, 0);
  assert.deepEqual(r.unchanged, { lines: 1, tagged: 1, counts: 1 });
});

test("case, spacing and the model's own reasoning are not changes", () => {
  const r = comparePids(
    [line("L-1", { spec_class: "AC03N", source: "read from the label" })],
    [line("l-1 ", { spec_class: " ac03n", source: "read from the drawing" })],
  );
  assert.equal(r.lines.length, 0);
});

test("a changed attribute names the field, before and after", () => {
  const r = comparePids([line("L-1")], [line("L-1", { size: '10"' })]);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].status, "changed");
  assert.deepEqual(r.lines[0].changes, [{ field: "size", before: '8"', after: '10"' }]);
});

test("added and removed lines and tags", () => {
  const r = comparePids([line("L-1"), valve("PCV-1")], [line("L-2", { from_equipment: "P-1" }), valve("PSV-9")]);
  assert.deepEqual(r.lines.map((c) => `${c.status} ${c.tagNumber}`).sort(), ["added L-2", "removed L-1"]);
  assert.deepEqual(r.tagged.map((c) => `${c.status} ${c.tagNumber}`).sort(), ["added PSV-9", "removed PCV-1"]);
});

test("a line gone and one with the same ends, size and class arrived is a possible renumber", () => {
  const r = comparePids([line("L-0004")], [line("L-0014")]);
  assert.equal(r.lines.length, 0);
  assert.deepEqual(r.renumbered.map((p) => [p.before, p.after]), [["L-0004", "L-0014"]]);
});

test("a renumber is never guessed between two candidates, nor from one blank end", () => {
  const two = comparePids([line("L-0004")], [line("L-0014"), line("L-0015")]);
  assert.equal(two.renumbered.length, 0);
  const blank = comparePids([line("L-0004", { to_equipment: "" })], [line("L-0014", { to_equipment: "" })]);
  assert.equal(blank.renumbered.length, 0);
});

test("a line across two sheets is compared sheet to sheet, whatever order it was read in", () => {
  const a = line("L-1", { sheet_number: "PID-0010" });
  const b = line("L-1", { sheet_number: "PID-0011" });
  assert.equal(comparePids([a, b], [b, a]).lines.length, 0);
  const moved = comparePids([a, b], [a]);
  assert.deepEqual(moved.lines[0].changes, [{ field: "sheet_number", before: "PID-0010 / PID-0011", after: "PID-0010" }]);
});

test("untagged valves are counted per line, symbol, size and class", () => {
  const r = comparePids([handValve(), handValve(), handValve()], [handValve({ quantity: "2" }), handValve(), handValve()]);
  assert.equal(r.counts.length, 1);
  assert.equal(r.counts[0].before, 3);
  assert.equal(r.counts[0].after, 4);
  assert.equal(r.counts[0].kind, "ball valve");
});

test("legend items are not part of the drawing's content", () => {
  const legend: CompareTag = { tagType: "legend_item", tagNumber: "FIC", sourcePage: 1, attributes: { meaning: "flow controller" } };
  const r = comparePids([legend], []);
  assert.equal(r.tagged.length, 0);
});
