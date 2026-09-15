// Prints the order the pipe reaches a sheet's welds, read from the drawing's
// geometry. No API call.
//
//   pnpm --filter @easy/worker exec tsx scripts/trace-run-order.ts <file.pdf> <page...>

import { readFileSync } from "node:fs";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";
import { readRunOrder } from "../src/extraction/isoRunOrder";

async function main() {
  const [, , pdfPath, ...pageArgs] = process.argv;
  if (!pdfPath || pageArgs.length === 0) {
    console.error("usage: tsx scripts/trace-run-order.ts <file.pdf> <page...>");
    process.exit(1);
  }
  const buf = readFileSync(pdfPath);
  for (const arg of pageArgs) {
    const page = Number(arg);
    const marks = await readWeldMarks(buf, page);
    const run = await readRunOrder(buf, page, marks);
    console.log(`\n=== page ${page} ===`);
    console.log(`weld marks located: ${marks.hits.length}/${marks.flagCount}`);
    console.log(`run: ${run.runPolylines} polylines, ${run.runLength.toFixed(0)}pt drawn`);
    console.log(`welds placed on the run: ${run.welds.length}${run.offRun.length ? `,  off the run: ${run.offRun.length}` : ""}`);
    console.log(`\n  order along the run (by weld-mark index, not weld number):`);
    for (const [i, w] of run.welds.entries()) {
      console.log(
        `   ${String(i + 1).padStart(3)}. mark #${String(w.hitIndex).padStart(2)} at (${w.position.x.toFixed(0)},${w.position.y.toFixed(0)})` +
          `  after ${w.comesAfter === null ? "-" : `#${w.comesAfter}`}${w.onBranch ? "   [branch]" : ""}`
      );
    }
  }
}

main();
