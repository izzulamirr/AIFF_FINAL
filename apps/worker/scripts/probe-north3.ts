import { readFileSync } from "node:fs";
import { readPageGeometry } from "../src/pdfGeometry";
type Pt = { x: number; y: number };
const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
async function main() {
  const [, , pdfPath, pageArg] = process.argv;
  const g = await readPageGeometry(readFileSync(pdfPath), Number(pageArg));
  const big = g.paths
    .filter((p) => p.paint !== "stroke" && p.extent >= 14 && p.extent <= 70 && p.points.length >= 3 && p.points.length <= 8)
    .map((p) => ({ c: { x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 }, e: p.extent, n: p.points.length }));
  // Isolated: few other big filled shapes within 120pt. Table borders, hatching
  // and the logo all come in crowds; a north arrow stands alone.
  const lonely = big.filter((a) => big.filter((b) => b !== a && d(a.c, b.c) < 120).length <= 3);
  console.log(`${big.length} big filled shapes, ${lonely.length} isolated:`);
  const seen = new Set<string>();
  for (const l of lonely) {
    const k = `${l.c.x.toFixed(0)},${l.c.y.toFixed(0)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`   (${l.c.x.toFixed(0)},${l.c.y.toFixed(0)}) extent ${l.e.toFixed(1)} pts ${l.n}`);
  }
}
main();
