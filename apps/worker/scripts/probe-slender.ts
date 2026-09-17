// Long slender filled triangles: the arrowhead style CAD uses when a
// dimension is too small to fit normal arrows inside it. Free.
//   pnpm --filter @easy/worker exec tsx scripts/probe-slender.ts <pdf>
import { readPageCount, readPageGeometry, type GeomPath } from "../src/pdfGeometry";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const AXES = [30, 90, 150];
const onAxis = (d: number) => AXES.some((a) => Math.min(Math.abs(d - a), 180 - Math.abs(d - a)) <= 8);
const ang = (a: Pt, b: Pt) => ((((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) % 180) + 180) % 180;

/** The vertex farthest from the midpoint of the other two. */
function apexOf(p: Pt[]): { apex: Pt; base: [Pt, Pt] } {
  let best = -1;
  let out = { apex: p[0], base: [p[1], p[2]] as [Pt, Pt] };
  for (let i = 0; i < 3; i++) {
    const o = [p[(i + 1) % 3], p[(i + 2) % 3]];
    const mid = { x: (o[0].x + o[1].x) / 2, y: (o[0].y + o[1].y) / 2 };
    const d = dist(p[i], mid);
    if (d > best) { best = d; out = { apex: p[i], base: [o[0], o[1]] }; }
  }
  return out;
}

async function main() {
  const pdf = process.argv[2];
  const pages = await readPageCount(pdf);
  let total = 0;
  for (let page = 1; page <= pages; page++) {
    const g = await readPageGeometry(pdf, page);
    const slender: Array<{ p: GeomPath; apex: Pt; len: number }> = [];
    for (const p of g.paths) {
      if (p.paint === "stroke") continue;
      const pts = p.points.slice(0, 3);
      if (p.points.length < 3 || p.points.length > 4 || pts.length < 3) continue;
      if (p.extent <= 12 || p.extent > 60) continue;            // bigger than a normal head
      const { apex, base } = apexOf(pts);
      const baseLen = dist(base[0], base[1]);
      const h = Math.abs((base[1].x - base[0].x) * (apex.y - base[0].y) - (base[1].y - base[0].y) * (apex.x - base[0].x)) / (baseLen || 1);
      if (h < 1 || baseLen / h < 1.6) continue;                  // must be SLENDER
      slender.push({ p, apex, len: baseLen });
    }
    // Pair them: two slivers whose apexes face each other along one axis.
    const pairs: string[] = [];
    for (let i = 0; i < slender.length; i++)
      for (let j = i + 1; j < slender.length; j++) {
        const a = slender[i], b = slender[j];
        const span = dist(a.apex, b.apex);
        if (span < 8 || span > 70) continue;
        if (!onAxis(ang(a.apex, b.apex))) continue;
        if (Math.abs(a.len - b.len) > Math.max(a.len, b.len) * 0.35) continue;
        pairs.push(`(${a.apex.x.toFixed(1)},${a.apex.y.toFixed(1)})-(${b.apex.x.toFixed(1)},${b.apex.y.toFixed(1)}) span ${span.toFixed(1)}pt deg${ang(a.apex, b.apex).toFixed(0)}`);
      }
    total += pairs.length;
    console.log(`page ${page}: ${slender.length} slender triangles, ${pairs.length} facing pairs`);
    for (const s of pairs) console.log(`    ${s}`);
  }
  console.log(`\n${total} candidate tick-style dimensions across the document`);
}
main();
