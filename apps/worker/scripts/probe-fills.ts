// Filled shapes (arrowheads, weld dots) inside a page rectangle. Free.
//   pnpm --filter @easy/worker exec tsx scripts/probe-fills.ts <pdf> <page> <x0> <y0> <x1> <y1>
import { readPageGeometry } from "../src/pdfGeometry";
async function main() {
  const [, , pdf, pg, X0, Y0, X1, Y1] = process.argv;
  const g = await readPageGeometry(pdf, Number(pg));
  const inBox = (p: { x: number; y: number }) =>
    p.x >= Number(X0) && p.x <= Number(X1) && p.y >= Number(Y0) && p.y <= Number(Y1);
  for (const p of g.paths) {
    if (p.paint === "stroke") continue;
    const c = { x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 };
    if (!inBox(c)) continue;
    console.log(
      `${p.paint.padEnd(10)} pts${String(p.points.length).padStart(3)} extent${p.extent.toFixed(1).padStart(6)} ` +
        `centre (${c.x.toFixed(1)},${c.y.toFixed(1)})  ${p.points.map((q) => `(${q.x.toFixed(1)},${q.y.toFixed(1)})`).join(" ")}`
    );
  }
}
main();
