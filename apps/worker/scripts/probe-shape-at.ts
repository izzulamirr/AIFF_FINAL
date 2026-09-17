// Every path whose centre sits within <radius> of a point, printed with its
// actual point list -- so a shape found by a detector can be pinned in a test
// as the drawing really draws it, rather than as an invented approximation.
// Free.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-shape-at.ts <pdf> <page> <x> <y> [radius]
import { readFileSync } from "node:fs";
import { readPageGeometry } from "../src/pdfGeometry";

async function main() {
  const [, , pdf, pageArg, xArg, yArg, rArg] = process.argv;
  if (!pdf || !pageArg || !xArg || !yArg) {
    console.error("usage: tsx scripts/probe-shape-at.ts <pdf> <page> <x> <y> [radius]");
    process.exit(1);
  }
  const x = Number(xArg);
  const y = Number(yArg);
  const r = Number(rArg ?? 6);
  const g = await readPageGeometry(readFileSync(pdf), Number(pageArg));
  for (const p of g.paths) {
    const cx = (p.bbox.x0 + p.bbox.x1) / 2;
    const cy = (p.bbox.y0 + p.bbox.y1) / 2;
    if (Math.hypot(cx - x, cy - y) > r) continue;
    console.log(
      `${p.paint} lw=${p.lw?.toFixed(2)} extent=${p.extent.toFixed(1)} pts=${p.points.length} centre=(${cx.toFixed(1)},${cy.toFixed(1)})\n  [${p.points
        .map((q) => `{ x: ${q.x.toFixed(1)}, y: ${q.y.toFixed(1)} }`)
        .join(", ")}]`
    );
  }
}
main();
