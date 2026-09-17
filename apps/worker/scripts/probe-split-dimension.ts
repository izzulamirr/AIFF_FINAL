// What is drawn where a dimension line is SPLIT by its own text?
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-split-dimension.ts <pdf> <page> <x0> <y0> <x1> <y1>
import { readFileSync } from "node:fs";
import { readPageGeometry, type GeomPath } from "../src/pdfGeometry";

type Pt = { x: number; y: number };
const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

async function main() {
  const [, , pdfPath, pageArg, x0a, y0a, x1a, y1a] = process.argv;
  const X0 = Number(x0a), Y0 = Number(y0a), X1 = Number(x1a), Y1 = Number(y1a);
  const geom = await readPageGeometry(readFileSync(pdfPath), Number(pageArg));
  const inBox = (p: GeomPath) => p.bbox.x1 >= X0 && p.bbox.x0 <= X1 && p.bbox.y1 >= Y0 && p.bbox.y0 <= Y1;
  const heads = geom.paths.filter((p) => p.paint !== "stroke" && p.points.length >= 3 && p.points.length <= 4 && p.extent >= 3 && p.extent <= 12);
  console.log(`region ${X0},${Y0} - ${X1},${Y1}  (page is ${geom.width.toFixed(0)}x${geom.height.toFixed(0)}pt)`);
  console.log(`\nfilled triangles (arrowhead candidates) in region:`);
  for (const h of heads.filter(inBox)) {
    const c = centre(h);
    console.log(`   (${c.x.toFixed(1)},${c.y.toFixed(1)}) extent ${h.extent.toFixed(1)} pts ${h.points.length} paint ${h.paint}`);
  }
  console.log(`\nstroked 2-point lines in region:`);
  const lines = geom.paths.filter((p) => p.paint === "stroke" && p.points.length === 2 && inBox(p));
  for (const l of lines.sort((a, b) => b.extent - a.extent)) {
    const [a, b] = l.points;
    const len = dist(a, b);
    const deg = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 180;
    const nearA = heads.filter((h) => dist(centre(h), a) <= 6).length;
    const nearB = heads.filter((h) => dist(centre(h), b) <= 6).length;
    console.log(`   (${a.x.toFixed(1)},${a.y.toFixed(1)}) -> (${b.x.toFixed(1)},${b.y.toFixed(1)})  ${len.toFixed(1)}pt ${deg.toFixed(0)}deg lw ${l.lineWidth.toFixed(2)}  heads[${nearA},${nearB}]`);
  }
}
main();
