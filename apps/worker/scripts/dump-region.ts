// Renders one rectangle of a page to a PNG, to look at. No API call.
//   pnpm --filter @easy/worker exec tsx scripts/dump-region.ts <pdf> <page> <x0> <y0> <x1> <y1> <out.png> [scale]
import { readFileSync, writeFileSync } from "node:fs";
import { renderRegionContactSheet } from "../src/pdfImages";

async function main() {
  const [, , pdfPath, pageArg, x0, y0, x1, y1, outPath] = process.argv;
  const png = await renderRegionContactSheet(readFileSync(pdfPath), Number(pageArg), [
    { label: `${x0},${y0}-${x1},${y1}`, bbox: { x0: Number(x0), y0: Number(y0), x1: Number(x1), y1: Number(y1) } },
  ]);
  if (!png) return console.log("nothing rendered");
  writeFileSync(outPath, Buffer.from(png, "base64"));
  console.log(`-> ${outPath}`);
}
main();
