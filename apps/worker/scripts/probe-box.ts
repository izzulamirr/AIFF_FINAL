// Every stroked segment inside a page rectangle, with its angle. Free.
//   pnpm --filter @easy/worker exec tsx scripts/probe-box.ts <pdf> <page> <x0> <y0> <x1> <y1> [minLen]
import { readPageGeometry } from "../src/pdfGeometry";
async function main() {
  const [, , pdf, pg, X0, Y0, X1, Y1, ML] = process.argv;
  const g = await readPageGeometry(pdf, Number(pg));
  const H = g.height, minLen = Number(ML ?? 8);
  const f = (p: any) => ({ x: p.x, y: p.y }); void H;
  const ang = (a: any, b: any) => (((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI % 180) + 180) % 180;
  const inBox = (p: any) => p.x >= Number(X0) && p.x <= Number(X1) && p.y >= Number(Y0) && p.y <= Number(Y1);
  const rows: any[] = [];
  for (const p of g.paths) {
    if (p.paint === "fill") continue;
    for (let i = 0; i + 1 < p.points.length; i++) {
      const a = f(p.points[i]), b = f(p.points[i + 1]);
      const len = Math.hypot(a.x - b.x, a.y - b.y);
      if (len < minLen) continue;
      if (!inBox(a) && !inBox(b)) continue;
      rows.push({ a, b, len, lw: p.lineWidth, d: ang(a, b) });
    }
  }
  rows.sort((x, y) => y.len - x.len);
  console.log(`${rows.length} segments >=${minLen}pt touching box\n`);
  for (const r of rows.slice(0, 60))
    console.log(`len${r.len.toFixed(1).padStart(7)} lw${r.lw.toFixed(2)} deg${r.d.toFixed(1).padStart(6)}  (${r.a.x.toFixed(1)},${r.a.y.toFixed(1)})-(${r.b.x.toFixed(1)},${r.b.y.toFixed(1)})`);
}
main();
