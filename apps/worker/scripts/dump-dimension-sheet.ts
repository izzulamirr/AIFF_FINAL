// Finds a page's dimensions and lays their printed numbers on one contact
// sheet, so they can be read in a single pass. Local render, no API call.
//
//   pnpm --filter @easy/worker exec tsx scripts/dump-dimension-sheet.ts <file.pdf> <page> <out.png>

import { readFileSync, writeFileSync } from "node:fs";
import { readDimensions } from "../src/extraction/isoDimensions";
import { renderRegionContactSheet } from "../src/pdfImages";

async function main() {
  const [, , pdfPath, pageArg, outPath] = process.argv;
  const page = Number(pageArg);
  const buf = readFileSync(pdfPath);
  const r = await readDimensions(buf, page);
  const withLabel = r.dimensions.filter((d) => d.labelBox);
  const split = r.dimensions.filter((d) => d.drawnAs === "split").length;
  const onPipe = r.dimensions.filter((d) => d.measuresPipe).length;
  console.log(
    `page ${page}: ${r.dimensions.length} dimensions (${r.dimensions.length - split} drawn as one line, ${split} split by their text), ${onPipe} measuring pipe, ${withLabel.length} with a label box\n`
  );
  r.dimensions.forEach((d, i) =>
    console.log(
      `  [${String(i + 1).padStart(2)}] (${d.from.x.toFixed(0)},${d.from.y.toFixed(0)}) -> (${d.to.x.toFixed(0)},${d.to.y.toFixed(0)})  ${String(d.pagePt).padStart(6)}pt  ${String(d.degrees).padStart(5)}deg  ${d.drawnAs.padEnd(5)}  ${d.measuresPipe ? `pipe@${String(d.witnessDegrees).padStart(5)}deg` : "NOT ON PIPE   "}  ${d.labelBox ? "label" : "NO LABEL"}`
    )
  );
  console.log("");
  withLabel.forEach((d, i) =>
    console.log(
      `  #${i + 1}: (${d.from.x.toFixed(0)},${d.from.y.toFixed(0)}) -> (${d.to.x.toFixed(0)},${d.to.y.toFixed(0)})  ${d.pagePt}pt  ${d.degrees}deg  ${d.drawnAs}`
    )
  );
  if (r.splitRejections.length > 0) {
    console.log(`\n${r.splitRejections.length} collinear outward-facing pair(s) NOT taken as a split dimension:`);
    for (const s of r.splitRejections) {
      console.log(`   (${s.at.x.toFixed(0)},${s.at.y.toFixed(0)})  span ${s.spanPt}pt  gap ${s.gapPt}pt  -- ${s.why}`);
    }
  }
  const png = await renderRegionContactSheet(buf, page, withLabel.map((d, i) => ({ label: String(i + 1), bbox: d.labelBox! })));
  if (!png) return console.log("nothing to render");
  writeFileSync(outPath, Buffer.from(png, "base64"));
  console.log(`\n-> ${outPath}`);
}
main();
