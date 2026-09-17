// Looks for DIMENSION lines in a page's geometry: a line with an arrowhead at
// each end, offset from and parallel to what it measures. No API call.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-dimensions.ts <file.pdf> <page>

import { readFileSync } from "node:fs";
import { readPageGeometry, type GeomPath } from "../src/pdfGeometry";

type Pt = { x: number; y: number };
const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

async function main() {
  const [, , pdfPath, pageArg] = process.argv;
  const geom = await readPageGeometry(readFileSync(pdfPath), Number(pageArg));
  console.log(`page ${pageArg}: ${geom.paths.length} paths, ${geom.width.toFixed(0)}x${geom.height.toFixed(0)}pt\n`);

  // What shapes are there at all? Point-count by paint, for the small filled
  // things -- arrowheads, weld dots and glyph strokes all live in here.
  const buckets = new Map<string, number>();
  for (const p of geom.paths) {
    const small = p.extent <= 12;
    const k = `${p.paint}/${p.points.length}pt/${small ? "small" : "large"}`;
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  console.log("shape census (top 18):");
  for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`   ${String(n).padStart(5)}  ${k}`);

  // Arrowhead candidates: small filled triangles.
  const heads = geom.paths.filter((p) => p.paint !== "stroke" && p.points.length >= 3 && p.points.length <= 4 && p.extent >= 3 && p.extent <= 12);
  console.log(`\n${heads.length} small filled triangles (arrowhead candidates)`);

  // A dimension line: a straight stroked run with a head at BOTH ends.
  const lines = geom.paths.filter((p) => p.paint === "stroke" && p.points.length === 2 && p.extent > 12);
  console.log(`${lines.length} straight stroked lines over 12pt`);

  const headAt = (q: Pt, tol: number) => heads.find((h) => dist(centre(h), q) <= tol);
  const found: Array<{ a: Pt; b: Pt; len: number; deg: number }> = [];
  for (const l of lines) {
    const a = l.points[0];
    const b = l.points[1];
    if (!headAt(a, 6) || !headAt(b, 6)) continue;
    const deg = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 180;
    found.push({ a, b, len: dist(a, b), deg });
  }
  console.log(`\n${found.length} lines with an arrowhead at BOTH ends -- dimension lines:`);
  for (const d of found.sort((x, y) => y.len - x.len).slice(0, 25)) {
    console.log(`   (${d.a.x.toFixed(0)},${d.a.y.toFixed(0)}) -> (${d.b.x.toFixed(0)},${d.b.y.toFixed(0)})  ${d.len.toFixed(0)}pt  ${d.deg.toFixed(0)}deg`);
  }
}
main();
