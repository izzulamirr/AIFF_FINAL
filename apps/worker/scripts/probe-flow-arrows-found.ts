// What findFlowArrows ACTUALLY returns, page by page -- the module itself, not
// a probe's copy of its rules. Free.
//   pnpm --filter @easy/worker exec tsx scripts/probe-flow-arrows-found.ts <pdf>
import { readFileSync } from "node:fs";
import { readPageCount } from "../src/pdfGeometry";
import { readFlowArrows } from "../src/extraction/isoFlowArrows";

async function main() {
  const pdf = process.argv[2];
  const buf = readFileSync(pdf);
  let total = 0;
  for (let page = 1; page <= (await readPageCount(pdf)); page++) {
    const found = await readFlowArrows(buf, page);
    total += found.length;
    console.log(
      `  page ${page}: ${found.length}` +
        found.map((a) => `  (${a.at.x.toFixed(0)},${a.at.y.toFixed(0)}) ${a.onPipePt.toFixed(1)}pt off, ${a.alongDeg.toFixed(1)}deg`).join("")
    );
  }
  console.log(`  total ${total}`);
}
main();
