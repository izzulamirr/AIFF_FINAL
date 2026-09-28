// A spec's pipe table read by geometry: which size columns a merged cell covers is a
// matter of where its rules are drawn, not something to infer.
//
// The table here is drawn by hand -- words with coordinates, and the rules around them --
// so the rule under test is pinned without a PDF: a value spans the size columns between
// the vertical rules either side of it ON ITS OWN ROW.
import test from "node:test";
import assert from "node:assert/strict";
import { classRowsFromTable, pipeRowsFromTable, readSpecTable, type RuleSeg, type TextItem } from "./specTable";

const word = (str: string, x0: number, x1: number, y: number): TextItem => ({ str, x0, x1, y0: y - 3, y1: y + 3 });
const H = (a: number, b0: number, b1: number): RuleSeg => ({ kind: "H", a, b0, b1 });
const V = (a: number, b0: number, b1: number): RuleSeg => ({ kind: "V", a, b0, b1 });

// Size columns 30 wide from x=60: 1/2 | 1 | 2 | 3 | 4 | 26-30.
const COLS = [
  ["1/2", 60],
  ["1", 90],
  ["2", 120],
  ["3", 150],
  ["4", 180],
  ["26-30", 210],
] as const;
const RIGHT = 240;

function build(scheduleCells: Array<[string, number, number]>, endsCells: Array<[string, number, number]>, matCells: Array<[string, number, number]>) {
  const items: TextItem[] = [word("SIZE (Inch)", 22, 56, 15)];
  for (const [label, x] of COLS) items.push(word(label, x + 8, x + 22, 15));
  const segs: RuleSeg[] = [];

  // Header band 10..20: a rule between every size column.
  for (const [, x] of COLS) segs.push(V(x, 10, 20));
  segs.push(V(RIGHT, 10, 20));
  // Row rules across the whole table.
  for (const y of [10, 20, 30, 40, 50]) segs.push(H(y, 0, RIGHT));
  // The narrow group column (PIPE) and the label column's right edge.
  segs.push(V(0, 10, 50), V(20, 20, 50), V(60, 10, 50), V(RIGHT, 20, 50));
  items.push(word("PIPE", 2, 18, 35));

  const rows: Array<[string, number, number, Array<[string, number, number]>]> = [
    ["Schedule", 20, 30, scheduleCells],
    ["Ends", 30, 40, endsCells],
    ["Mat'l Specification", 40, 50, matCells],
  ];
  for (const [label, top, bottom, cells] of rows) {
    const mid = (top + bottom) / 2;
    items.push(word(label, 24, 56, mid));
    for (const [text, from, to] of cells) {
      items.push(word(text, from + 6, to - 6, mid));
      // A cell's own edges. Rules between the size columns it spans are simply not drawn.
      segs.push(V(from, top, bottom), V(to, top, bottom));
    }
  }
  return { items, segs };
}

test("a schedule that spans several size columns is given to each of them, and only them", () => {
  const { items, segs } = build(
    [["160", 60, 120], ["80", 120, 180], ["40", 180, 210], ["8.74", 210, 240]],
    [["PE", 60, 120], ["BE", 120, 240]],
    [["A106 Gr.B", 60, 210], ["A672", 210, 240]]
  );
  const table = readSpecTable(items, segs)!;
  assert.ok(table, "the table is found");
  assert.deepEqual(table.columns.map((c) => c.label), ["1/2", "1", "2", "3", "4", "26-30"]);

  const pipes = pipeRowsFromTable(table)!;
  assert.deepEqual(pipes.issues, []);
  assert.deepEqual(
    pipes.rows.map((r) => `${r.size_min}${r.size_max !== r.size_min ? "-" + r.size_max : ""}=${r.schedule}/${r.end_type}`),
    ["1/2=160/PE", "1=160/PE", "2=80/BE", "3=80/BE", "4=40/BE", "26-30=8.74mm/BE"]
  );
  assert.equal(pipes.rows[0].material, "A106 Gr.B");
  assert.equal(pipes.rows[5].material, "A672");
});

test("the same word over different columns gives different answers -- position decides", () => {
  // Identical text, cell drawn one column further along: "80" now covers 3 and 4.
  const a = build([["160", 60, 120], ["80", 120, 180], ["40", 180, 240]], [["BE", 60, 240]], [["X", 60, 240]]);
  const b = build([["160", 60, 120], ["80", 120, 150], ["40", 150, 240]], [["BE", 60, 240]], [["X", 60, 240]]);
  const sched = (t: ReturnType<typeof build>) => pipeRowsFromTable(readSpecTable(t.items, t.segs)!)!.rows.map((r) => r.schedule);
  assert.deepEqual(sched(a), ["160", "160", "80", "80", "40", "40"]);
  assert.deepEqual(sched(b), ["160", "160", "80", "40", "40", "40"]);
});

test("a column with no value under it is reported, not silently filled", () => {
  const { items, segs } = build([["160", 60, 120], ["80", 120, 180]], [["BE", 60, 240]], [["X", 60, 240]]);
  const pipes = pipeRowsFromTable(readSpecTable(items, segs)!)!;
  assert.ok(pipes.issues.some((i) => /Schedule has no value under 4/.test(i)), pipes.issues.join(" | "));
});

test("a bare decimal schedule is a wall thickness in mm", () => {
  const { items, segs } = build([["8.74", 60, 240]], [["BE", 60, 240]], [["X", 60, 240]]);
  assert.equal(pipeRowsFromTable(readSpecTable(items, segs)!)!.rows[0].schedule, "8.74mm");
});

test("a page with no size row has no table", () => {
  assert.equal(readSpecTable([word("Some other page", 10, 90, 10)], [H(10, 0, 100)]), null);
});

test("a mixed fraction printed with a dash is one size, not a range", () => {
  const items: TextItem[] = [word("SIZE (Inch)", 22, 56, 15), word("1", 68, 82, 15), word("1-1/2", 98, 112, 15), word("2", 128, 142, 15)];
  const segs = [V(60, 10, 20), V(90, 10, 20), V(120, 10, 20), V(150, 10, 20), H(10, 0, 150), H(20, 0, 150), H(30, 0, 150)];
  const table = readSpecTable(items, segs)!;
  assert.deepEqual([table.columns[1].min, table.columns[1].max], ["1 1/2", "1 1/2"]);
});

test("fittings and flanges rows carry the sizes their cell spans", () => {
  const { items, segs } = build([["160", 60, 240]], [["BE", 60, 240]], [["A106", 60, 240]]);
  // One fittings row under the pipe rows: a cell over 1/2..1, another over 2..26-30.
  segs.push(H(60, 0, RIGHT), V(20, 50, 60), V(60, 50, 60), V(120, 50, 60), V(RIGHT, 50, 60));
  items.push(word("Cap", 24, 44, 55), word("A105N, SW", 66, 110, 55), word("A234, BW", 126, 170, 55));
  const rows = classRowsFromTable(readSpecTable(items, segs)!)!;
  assert.deepEqual(
    rows.fittings.map((r) => [r.fitting_type, r.size_min, r.size_max, r.end_type]),
    [
      ["Cap", "1/2", "1", "SW"],
      ["Cap", "2", "30", "BW"],
    ]
  );
});
