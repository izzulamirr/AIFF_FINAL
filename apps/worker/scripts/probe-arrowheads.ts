// The exact vertices of the small filled triangles in a region.
//   pnpm --filter @easy/worker exec tsx scripts/probe-arrowheads.ts <pdf> <page> <x0> <y0> <x1> <y1>
import { readFileSync } from "node:fs";
import { readPageGeometry, type GeomPath } from "../src/pdfGeometry";

async function main() {
  const [, , pdfPath, pageArg, x0a, y0a, x1a, y1a] = process.argv;
  const X0 = Number(x0a), Y0 = Number(y0a), X1 = Number(x1a), Y1 = Number(y1a);
  const geom = await readPageGeometry(readFileSync(pdfPath), Number(pageArg));
  const inBox = (p: GeomPath) => p.bbox.x1 >= X0 && p.bbox.x0 <= X1 && p.bbox.y1 >= Y0 && p.bbox.y0 <= Y1;
  for (const p of geom.paths) {
    if (p.paint === "stroke" || p.points.length < 3 || p.points.length > 4) continue;
    if (p.extent < 3 || p.extent > 12 || !inBox(p)) continue;
    const c = { x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 };
    console.log(`centre (${c.x.toFixed(1)},${c.y.toFixed(1)})  extent ${p.extent.toFixed(1)}`);
    p.points.forEach((q, i) => console.log(`      v${i} (${q.x.toFixed(1)},${q.y.toFixed(1)})`));
  }
}
main();
