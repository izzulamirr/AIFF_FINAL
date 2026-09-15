// Builds the weld-flag contact sheet for a page and writes it to disk, so it can
// be looked at before anything is sent anywhere. Local render, no API call.
//
//   pnpm --filter @easy/worker exec tsx scripts/dump-flag-sheet.ts <file.pdf> <page> <out.png>

import { readFileSync, writeFileSync } from "node:fs";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";
import { renderRegionContactSheet } from "../src/pdfImages";

async function main() {
  const [, , pdfPath, pageArg, outPath] = process.argv;
  if (!pdfPath || !pageArg || !outPath) {
    console.error("usage: tsx scripts/dump-flag-sheet.ts <file.pdf> <page> <out.png>");
    process.exit(1);
  }
  const page = Number(pageArg);
  const buf = readFileSync(pdfPath);

  const marks = await readWeldMarks(buf, page);
  // Every flag, traced or not -- reading the number does not depend on whether
  // its leader was followed.
  const regions = [
    ...marks.hits.map((h) => ({ flagBox: h.flagBox, mark: h.mark as { x: number; y: number } | null })),
    ...marks.untraced.map((u) => ({ flagBox: { x0: u.x - 27, y0: u.y - 8, x1: u.x + 27, y1: u.y + 8 }, mark: null })),
  ];
  // Reading order: down the sheet, then across, so the grid follows the drawing.
  regions.sort((a, b) => a.flagBox.y0 - b.flagBox.y0 || a.flagBox.x0 - b.flagBox.x0);

  const png = await renderRegionContactSheet(
    buf,
    page,
    regions.map((r, i) => ({ label: String(i + 1), bbox: r.flagBox }))
  );
  if (!png) {
    console.log("nothing to render");
    return;
  }
  const bytes = Buffer.from(png, "base64");
  writeFileSync(outPath, bytes);
  console.log(`${regions.length} flags -> ${outPath}  ${(bytes.length / 1024).toFixed(0)}kb`);
  for (const [i, r] of regions.entries()) {
    console.log(`  cell ${i + 1}: flag at (${r.flagBox.x0.toFixed(0)},${r.flagBox.y0.toFixed(0)})${r.mark ? `  weld mark (${r.mark.x.toFixed(0)},${r.mark.y.toFixed(0)})` : "  [leader untraced]"}`);
  }
}

main();
