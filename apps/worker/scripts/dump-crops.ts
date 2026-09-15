// Writes close-up crops of a sheet to disk so they can be looked at. Local
// render, no API call.
//
//   pnpm --filter @easy/worker exec tsx scripts/dump-crops.ts <file.pdf> <page> <outDir> <regions.json>
//
// <regions.json>: [{ label, x, y, w, h }] with x/y the CENTRE of the region and
// w/h its size, all as fractions of the page.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { renderPdfPageCrops } from "../src/pdfImages";

async function main() {
  const [, , pdfPath, pageArg, outDir, regionsPath] = process.argv;
  if (!pdfPath || !pageArg || !outDir || !regionsPath) {
    console.error("usage: tsx scripts/dump-crops.ts <file.pdf> <page> <outDir> <regions.json>");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const regions = JSON.parse(readFileSync(regionsPath, "utf8"));
  const crops = await renderPdfPageCrops(readFileSync(pdfPath), Number(pageArg), regions);
  for (const c of crops) {
    const bytes = Buffer.from(c.pngBase64, "base64");
    writeFileSync(`${outDir}/${c.label}.png`, bytes);
    console.log(`${c.label}.png  ${(bytes.length / 1024).toFixed(0)}kb`);
  }
}

main();
