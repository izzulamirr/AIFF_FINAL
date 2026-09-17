// Flow arrows: a filled triangle sitting ON the pipe, pointing along it.
// Not a dimension terminator (those sit at the end of a thin line) and not a
// weld dot (those are blobs, not triangles). Free.
//   pnpm --filter @easy/worker exec tsx scripts/probe-flow-arrows.ts <pdf>
import { readPageCount, readPageGeometry } from "../src/pdfGeometry";
type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
async function main() {
  const pdf = process.argv[2];
  const pages = await readPageCount(pdf);
  for (let page = 1; page <= pages; page++) {
    const g = await readPageGeometry(pdf, page);
    const pipe: Array<{ a: Pt; b: Pt }> = [];
    for (const p of g.paths) {
      if (p.paint === "fill" || p.lineWidth < 1.5) continue;
      for (let i = 1; i < p.points.length; i++) if (dist(p.points[i - 1], p.points[i]) > 4) pipe.push({ a: p.points[i - 1], b: p.points[i] });
    }
    const hits: string[] = [];
    for (const p of g.paths) {
      if (p.paint === "stroke" || p.points.length < 3 || p.points.length > 4) continue;
      if (p.extent < 4 || p.extent > 16) continue;
      const c = { x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 };
      // ON the pipe, and not at either END of its segment (a terminator is).
      for (const s of pipe) {
        const L = dist(s.a, s.b) || 1;
        const t = ((c.x - s.a.x) * (s.b.x - s.a.x) + (c.y - s.a.y) * (s.b.y - s.a.y)) / (L * L);
        if (t < 0.12 || t > 0.88) continue;
        const foot = { x: s.a.x + t * (s.b.x - s.a.x), y: s.a.y + t * (s.b.y - s.a.y) };
        if (dist(c, foot) > 2.5) continue;
        hits.push(`(${c.x.toFixed(0)},${c.y.toFixed(0)}) extent${p.extent.toFixed(1)}`);
        break;
      }
    }
    console.log(`page ${page}: ${hits.length} filled triangles sitting mid-pipe   ${hits.slice(0, 6).join("  ")}`);
  }
}
main();
