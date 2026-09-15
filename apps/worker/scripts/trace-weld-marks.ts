// Traces each weld's number flag to its mark on the pipe, from the PDF's own
// vector geometry. No API call, no cost.
//
//   pnpm --filter @easy/worker exec tsx scripts/trace-weld-marks.ts <file.pdf> <page...>
//
// Positions come out in page points and as page fractions, the latter being what
// scripts/dump-crops.ts takes -- so a flag can be cropped to read its number, or
// a weld's position compared against a valve's.

import { readFileSync } from "node:fs";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";

async function main() {
  const [, , pdfPath, ...pageArgs] = process.argv;
  if (!pdfPath || pageArgs.length === 0) {
    console.error("usage: tsx scripts/trace-weld-marks.ts <file.pdf> <page...>");
    process.exit(1);
  }
  const buf = readFileSync(pdfPath);

  for (const arg of pageArgs) {
    const page = Number(arg);
    const r = await readWeldMarks(buf, page);
    console.log(`\n=== page ${page} (${r.width.toFixed(0)} x ${r.height.toFixed(0)} pt) ===`);
    console.log(`number flags found: ${r.flagCount}`);
    console.log(`traced to a weld mark: ${r.hits.length}${r.untraced.length ? `,  untraced: ${r.untraced.length}` : ""}\n`);

    const rows = [...r.hits].sort((a, b) => a.mark.y - b.mark.y || a.mark.x - b.mark.x);
    for (const h of rows) {
      console.log(
        `  flag (${h.flag.x.toFixed(0)},${h.flag.y.toFixed(0)})` +
          `  ->  weld mark (${h.mark.x.toFixed(0)},${h.mark.y.toFixed(0)})` +
          `  frac (${(h.mark.x / r.width).toFixed(3)},${(h.mark.y / r.height).toFixed(3)})` +
          `  ${h.hops} hop, fit ${h.markDistance.toFixed(1)}pt`
      );
    }
    for (const u of r.untraced) console.log(`  flag (${u.x.toFixed(0)},${u.y.toFixed(0)})  -- no leader traced`);
  }
}

main();
