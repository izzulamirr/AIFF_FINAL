// Where is the NORTH arrow? Bigger than a dimension arrowhead, and filled.
//   pnpm --filter @easy/worker exec tsx scripts/probe-north.ts <pdf> <page>
import { readFileSync } from "node:fs";
import { readPageGeometry } from "../src/pdfGeometry";

async function main() {
  const [, , pdfPath, pageArg] = process.argv;
  const geom = await readPageGeometry(readFileSync(pdfPath), Number(pageArg));
  const cands = geom.paths.filter((p) => p.paint !== "stroke" && p.extent >= 12 && p.extent <= 60 && p.points.length >= 3 && p.points.length <= 12);
  console.log(`${cands.length} filled shapes 12-60pt (page ${geom.width.toFixed(0)}x${geom.height.toFixed(0)}):`);
  for (const p of cands) {
    const c = { x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 };
    console.log(`   (${c.x.toFixed(0)},${c.y.toFixed(0)}) extent ${p.extent.toFixed(1)} pts ${p.points.length} paint ${p.paint}`);
  }
}
main();
