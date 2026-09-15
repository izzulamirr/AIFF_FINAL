// Writes out the images a sheet is actually sent to the model as, so they can
// be looked at directly. Useful when extraction quality on a sheet is in
// question and it is not clear whether the detail is even legible at the
// resolution the model receives. Renders locally -- no API call, no cost.
//
//   pnpm --filter @easy/worker exec tsx scripts/dump-tiles.ts <file.pdf> <page> <outDir> [cols] [rows]

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { renderPdfPages, renderPdfPageTiles } from "../src/pdfImages";

const [, , pdfPath, pageArg, outDir, colsArg, rowsArg] = process.argv;
if (!pdfPath || !pageArg || !outDir) {
  console.error("usage: tsx scripts/dump-tiles.ts <file.pdf> <page> <outDir> [cols] [rows]");
  process.exit(1);
}

const page = Number(pageArg);
const cols = colsArg ? Number(colsArg) : undefined;
const rows = rowsArg ? Number(rowsArg) : undefined;

async function main() {
  mkdirSync(outDir, { recursive: true });
  const buf = readFileSync(pdfPath);

  const [whole] = await renderPdfPages(buf, [page]);
  if (whole) {
    writeFileSync(`${outDir}/page${page}-whole.png`, Buffer.from(whole.pngBase64, "base64"));
    console.log(`page${page}-whole.png`);
  }

  const tiles = await renderPdfPageTiles(buf, [page], cols, rows);
  for (const t of tiles) {
    const name = `page${page}-r${t.row}c${t.col}-of-${t.cols}x${t.rows}.png`;
    const bytes = Buffer.from(t.pngBase64, "base64");
    writeFileSync(`${outDir}/${name}`, bytes);
    console.log(`${name}  ${(bytes.length / 1024).toFixed(0)}kb`);
  }
}

main();
