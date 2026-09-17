// How many bolted joints does the cut finder see on each page? Free.
//   pnpm --filter @easy/worker exec tsx scripts/probe-joints.ts <pdf>
import { readPageCount, readPageGeometry, type GeomPath } from "../src/pdfGeometry";
import { boltedJoints, type Bar } from "../src/extraction/isoSpoolCuts";
type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const FLANGE_MIN_PT = 8, FLANGE_MAX_PT = 60, FLANGE_RATIO = 2.2;
function edgesOf(p: GeomPath) {
  let long = 0, short = Infinity, dir: Pt = { x: 1, y: 0 };
  for (let i = 1; i < p.points.length; i++) {
    const a = p.points[i - 1], b = p.points[i], d = dist(a, b);
    if (d < 0.01) continue;
    if (d > long) { long = d; dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; }
    if (d < short) short = d;
  }
  return { long, short: Number.isFinite(short) ? short : 0, dir };
}
const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });
async function main() {
  const pdf = process.argv[2];
  const pages = await readPageCount(pdf);
  for (let page = 1; page <= pages; page++) {
    const g = await readPageGeometry(pdf, page);
    const bars: Bar[] = [];
    let closed4 = 0;
    for (const p of g.paths) {
      if (p.paint !== "stroke") continue;
      if (p.points.length < 4 || p.points.length > 6) continue;
      closed4++;
      const e = edgesOf(p);
      if (e.long < FLANGE_MIN_PT || e.long > FLANGE_MAX_PT) continue;
      if (e.short < 0.01 || e.long / e.short < FLANGE_RATIO) continue;
      bars.push({ at: centre(p), dir: e.dir, long: e.long });
    }
    const sizes = bars.map((b) => b.long.toFixed(1));
    console.log(`page ${page}: ${closed4} 4-6pt paths, ${bars.length} flange bars, ${boltedJoints(bars).length} joints   bar lengths: ${[...new Set(sizes)].slice(0, 8).join(" ")}`);
  }
}
main();
