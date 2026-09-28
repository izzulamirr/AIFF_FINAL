// Free. Finds the pipe-size table on a client spec PDF and prints its text items and the
// ruling lines around it, to see what geometry the table reading has to work with.
//   pnpm --filter @easy/worker exec tsx scripts/probe-spec-table.ts <pdf> [page]
import { readFileSync } from "node:fs";
import { readPageCount, readPageGeometry } from "../src/pdfGeometry";
import { readTextItems } from "../src/pdfTextItems";

async function main() {
  const [, , pdfPath, pageArg] = process.argv;
  const buf = readFileSync(pdfPath);
  const pages = pageArg ? [Number(pageArg)] : Array.from({ length: await readPageCount(buf) }, (_, i) => i + 1);
  for (const page of pages) {
    const items = await readTextItems(buf, page);
    const hit = items.find((i) => /^SIZE\s*\(/i.test(i.str) || /^SIZE$/i.test(i.str));
    console.log(`page ${page}: ${items.length} text items, size-header ${hit ? `"${hit.str}" at y=${hit.y0.toFixed(1)}` : "none"}`);
    if (!hit || !pageArg) continue;

    const geom = await readPageGeometry(buf, page);
    const yTop = hit.y0 - 6;
    const yBot = yTop + 200;
    console.log("\n--- text items in the table band (x0..x1, y0..y1) ---");
    items
      .filter((i) => i.y1 >= yTop && i.y0 <= yBot)
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
      .forEach((i) => console.log(`${i.x0.toFixed(1).padStart(7)}..${i.x1.toFixed(1).padEnd(7)} y ${i.y0.toFixed(1).padStart(6)}..${i.y1.toFixed(1).padEnd(6)} ${JSON.stringify(i.str)}`));

    const segs: Array<{ kind: "H" | "V"; a: number; b0: number; b1: number; w: number }> = [];
    for (const p of geom.paths) {
      for (let k = 0; k + 1 < p.points.length; k++) {
        const s = p.points[k], e = p.points[k + 1];
        if (Math.abs(s.y - e.y) < 0.6 && Math.abs(s.x - e.x) > 4) segs.push({ kind: "H", a: (s.y + e.y) / 2, b0: Math.min(s.x, e.x), b1: Math.max(s.x, e.x), w: p.lineWidth });
        else if (Math.abs(s.x - e.x) < 0.6 && Math.abs(s.y - e.y) > 4) segs.push({ kind: "V", a: (s.x + e.x) / 2, b0: Math.min(s.y, e.y), b1: Math.max(s.y, e.y), w: p.lineWidth });
      }
    }
    const inBand = segs.filter((s) => (s.kind === "H" ? s.a >= yTop && s.a <= yBot : s.b1 >= yTop && s.b0 <= yBot));
    console.log(`\n--- ruling segments in the band: ${inBand.filter((s) => s.kind === "H").length} horizontal, ${inBand.filter((s) => s.kind === "V").length} vertical (of ${geom.paths.length} paths) ---`);
    inBand.filter((s) => s.kind === "H").sort((a, b) => a.a - b.a).slice(0, 14).forEach((s) => console.log(`H y=${s.a.toFixed(1)} x ${s.b0.toFixed(1)}..${s.b1.toFixed(1)} w=${s.w.toFixed(2)}`));
    inBand.filter((s) => s.kind === "V").sort((a, b) => a.a - b.a || a.b0 - b.b0).slice(0, 60).forEach((s) => console.log(`V x=${s.a.toFixed(1)} y ${s.b0.toFixed(1)}..${s.b1.toFixed(1)} w=${s.w.toFixed(2)}`));
  }
}
main();
