// Why was a split dimension near this point not taken? Free.
//   pnpm --filter @easy/worker exec tsx scripts/probe-reject.ts <pdf> <page> <x> <y> [radius]
import { readPageGeometry } from "../src/pdfGeometry";
import { findDimensions } from "../src/extraction/isoDimensions";
async function main() {
  const [, , pdf, pg, X, Y, R] = process.argv;
  const g = await readPageGeometry(pdf, Number(pg));
  const { dimensions, splitRejections } = findDimensions(g.paths);
  const at = { x: Number(X), y: Number(Y) };
  const r = Number(R ?? 25);
  const near = (p: { x: number; y: number }) => Math.hypot(p.x - at.x, p.y - at.y) <= r;
  console.log(`rejections within ${r}pt of (${X},${Y}):`);
  for (const x of splitRejections)
    if (near(x.at)) console.log(`  span${x.spanPt.toFixed(1).padStart(6)}pt gap${x.gapPt.toFixed(1).padStart(5)}pt  ${x.why}   ends (${x.ends[0].x.toFixed(1)},${x.ends[0].y.toFixed(1)})-(${x.ends[1].x.toFixed(1)},${x.ends[1].y.toFixed(1)})`);
  console.log(`\ndimensions TAKEN within ${r}pt:`);
  for (const d of dimensions)
    if (near(d.from) || near(d.to)) console.log(`  ${d.pagePt}pt deg${d.degrees} ${d.drawnAs} (${d.from.x},${d.from.y})-(${d.to.x},${d.to.y})`);
  console.log(`\ntotals: ${dimensions.length} taken, ${splitRejections.length} split rejections on page ${pg}`);
}
main();
