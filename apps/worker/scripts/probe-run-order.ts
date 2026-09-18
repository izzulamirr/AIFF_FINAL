// The order the run reaches each weld, and WHAT DECIDED which end it starts
// from. Free.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-run-order.ts <pdf> <flag-labels.json> [page]
//
// Sheet 3 of the reference ISO is the yardstick: it is the one sheet the walk
// orders exactly, and four different attempts at widening the run graph each
// reached more welds and got sheet 3 WRONG (see CLAUDE.md). So print it every
// time and check it before believing anything else here.
import { readFileSync } from "node:fs";
import { readPageCount } from "../src/pdfGeometry";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";
import { readRunOrder } from "../src/extraction/isoRunOrder";

async function main() {
  const [, , pdfPath, labelsPath, pageArg] = process.argv;
  if (!pdfPath || !labelsPath) {
    console.error("usage: tsx scripts/probe-run-order.ts <pdf> <flag-labels.json> [page]");
    process.exit(1);
  }
  const buf = readFileSync(pdfPath);
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Record<string, string>;
  const pages = pageArg ? [Number(pageArg)] : Array.from({ length: await readPageCount(pdfPath) }, (_, i) => i + 1);

  for (const page of pages) {
    const marks = await readWeldMarks(buf, page);
    const numberOf = (i: number) => Number(String(labels[`${page}-${i + 1}`] ?? "").replace(/^[A-Za-z\s]+/, ""));
    const run = await readRunOrder(buf, page, marks, numberOf);
    const seq = run.welds.map((w) => {
      const n = numberOf(w.hitIndex);
      return (Number.isFinite(n) && n > 0 ? String(n) : "?") + (w.onBranch ? "b" : "");
    });
    const arrows = run.flowArrows.map((a) => `(${a.at.x.toFixed(0)},${a.at.y.toFixed(0)})`).join(" ");
    console.log(
      `page ${page}: ${run.welds.length}/${marks.hits.length} ordered, oriented by ${run.orientedBy}` +
        (run.flowArrows.length ? `  [${run.flowArrows.length} flow arrow${run.flowArrows.length === 1 ? "" : "s"} ${arrows}]` : "")
    );
    console.log(`   ${seq.join(" -> ")}`);
  }
}
main();
