// Line-width census of a page, and where the heavy ones are. Free.
//   pnpm --filter @easy/worker exec tsx scripts/probe-lw.ts <pdf> <page> [minLw]
import { readPageGeometry } from "../src/pdfGeometry";
async function main() {
  const [, , pdf, pg, minLw] = process.argv;
  const g = await readPageGeometry(pdf, Number(pg));
  const tally = new Map<string, { n: number; len: number }>();
  for (const p of g.paths) {
    if (p.paint === "fill") continue;
    let len = 0;
    for (let i = 1; i < p.points.length; i++) len += Math.hypot(p.points[i].x - p.points[i - 1].x, p.points[i].y - p.points[i - 1].y);
    const k = p.lineWidth.toFixed(2);
    const t = tally.get(k) ?? { n: 0, len: 0 };
    t.n += 1; t.len += len;
    tally.set(k, t);
  }
  console.log("lw      paths    total length");
  for (const [k, v] of [...tally.entries()].sort((a, b) => Number(a[0]) - Number(b[0])))
    console.log(`${k.padStart(5)}  ${String(v.n).padStart(6)}  ${v.len.toFixed(0).padStart(10)}`);
  if (minLw) {
    console.log(`\nsegments with lw >= ${minLw}:`);
    let shown = 0;
    for (const p of g.paths) {
      if (p.paint === "fill" || p.lineWidth < Number(minLw)) continue;
      for (let i = 1; i < p.points.length && shown < 40; i++) {
        const a = p.points[i - 1], b = p.points[i];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if (L < 8) continue;
        console.log(`  lw${p.lineWidth.toFixed(2)} len${L.toFixed(1).padStart(7)} (${a.x.toFixed(1)},${a.y.toFixed(1)})-(${b.x.toFixed(1)},${b.y.toFixed(1)})`);
        shown++;
      }
    }
  }
}
main();
