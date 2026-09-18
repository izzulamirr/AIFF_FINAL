// Hunting the FLOW ARROWS on a drawing. Free.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-flow-arrow-candidates.ts <pdf> [page]
//
// A flow arrow is a filled triangle drawn ON the pipe, pointing the way the
// fluid goes. So are a leader's arrowhead and a dimension's terminator, which
// is why a bare "filled triangle" search returns 58-60 hits a page and is
// useless. This prints every filled triangle with the three things that could
// tell them apart, so the discriminator can be chosen from measurements rather
// than guessed:
//
//   onPipePt   how far its centre is from the nearest HEAVY (pipe) polyline
//   alongDeg   the angle between where it points and that polyline's direction
//   outline    whether a stroked self-crossing quad sits at the same centre
//
// Run it on a drawing that HAS flow arrows and one that does not; the rule is
// whatever separates the two.
import { readFileSync } from "node:fs";
import { readPageCount, readPageGeometry, type GeomPath } from "../src/pdfGeometry";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });

/** Where a triangle POINTS: the vertex furthest from the midpoint of the
 *  opposite edge, and the direction from that midpoint to it. */
function apexOf(t: GeomPath): { apex: Pt; dir: Pt } | null {
  const p = t.points.slice(0, 3);
  if (p.length !== 3) return null;
  let best: { apex: Pt; dir: Pt; d: number } | undefined;
  for (let i = 0; i < 3; i++) {
    const apex = p[i];
    const a = p[(i + 1) % 3];
    const b = p[(i + 2) % 3];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = dist(apex, mid);
    if (!best || d > best.d) best = { apex, dir: { x: (apex.x - mid.x) / (d || 1), y: (apex.y - mid.y) / (d || 1) }, d };
  }
  return best ? { apex: best.apex, dir: best.dir } : null;
}

function selfCrossing(p: GeomPath): boolean {
  if (p.points.length !== 4) return false;
  const [a, b, c, d] = p.points;
  const side = (o: Pt, q: Pt, r: Pt) => Math.sign((q.x - o.x) * (r.y - o.y) - (q.y - o.y) * (r.x - o.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

async function main() {
  const [, , pdfPath, pageArg] = process.argv;
  if (!pdfPath) {
    console.error("usage: tsx scripts/probe-flow-arrow-candidates.ts <pdf> [page]");
    process.exit(1);
  }
  const buf = readFileSync(pdfPath);
  const pages = pageArg ? [Number(pageArg)] : Array.from({ length: await readPageCount(pdfPath) }, (_, i) => i + 1);

  for (const page of pages) {
    const { paths } = await readPageGeometry(buf, page);
    const maxLw = Math.max(...paths.map((p) => p.lineWidth));
    // The pipe is the heaviest thing drawn -- the same test isoRunOrder uses.
    const heavy = paths.filter((p) => p.lineWidth >= maxLw - 0.01 && p.points.length >= 2);
    const segments: Array<[Pt, Pt]> = [];
    for (const h of heavy) for (let i = 1; i < h.points.length; i++) segments.push([h.points[i - 1], h.points[i]]);

    const outlines = paths.filter((p) => p.paint === "stroke" && selfCrossing(p)).map(centre);
    const tris = paths.filter((p) => (p.paint === "fill" || p.paint === "fillStroke") && p.points.length === 3);

    const rows = [];
    for (const t of tris) {
      const a = apexOf(t);
      if (!a) continue;
      const c = centre(t);
      let near: { d: number; along: number } | undefined;
      for (const [s0, s1] of segments) {
        const L = dist(s0, s1);
        if (L < 1) continue;
        const vx = (s1.x - s0.x) / L;
        const vy = (s1.y - s0.y) / L;
        let tt = ((c.x - s0.x) * vx + (c.y - s0.y) * vy) / L;
        tt = Math.max(0, Math.min(1, tt));
        const foot = { x: s0.x + tt * L * vx, y: s0.y + tt * L * vy };
        const d = dist(c, foot);
        // How parallel the arrow's direction is to this pipe, ignoring which
        // way round: |cos| of the angle between them.
        const cos = Math.abs(a.dir.x * vx + a.dir.y * vy);
        const along = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
        if (!near || d < near.d) near = { d, along };
      }
      if (!near) continue;
      const hasOutline = outlines.some((o) => dist(o, c) < 3);
      rows.push({ c, extent: t.extent, onPipePt: near.d, alongDeg: near.along, hasOutline });
    }

    const onPipe = rows.filter((r) => r.onPipePt <= 4);
    const alongPipe = onPipe.filter((r) => r.alongDeg <= 10);
    const withOutline = rows.filter((r) => r.hasOutline);
    const all3 = alongPipe.filter((r) => r.hasOutline);
    console.log(
      `page ${page}: ${tris.length} filled triangles; ${onPipe.length} on a pipe (<=4pt); ` +
        `${alongPipe.length} also ALONG it (<=10deg); ${withOutline.length} have a stroked outline; ${all3.length} have all three`
    );
    if (all3.length === 0) {
      // Say what ALMOST qualified, so a sheet reporting none can be told apart
      // from a sheet the detector is failing on.
      const near2 = rows.filter((r) => r.hasOutline && r.onPipePt <= 12).sort((a, b) => a.onPipePt - b.onPipePt).slice(0, 5);
      for (const r of near2) console.log(`   near-miss, has outline: (${r.c.x.toFixed(1)}, ${r.c.y.toFixed(1)})  extent ${r.extent.toFixed(1)}  ${r.onPipePt.toFixed(1)}pt off the pipe  ${r.alongDeg.toFixed(1)}deg off its axis`);
      // Every arrow measured on this drawing is 13.7-15.0pt. Show what sits on
      // the pipe, points along it, and is that size but has NO outline -- if a
      // sheet draws its arrow differently, it will be in here.
      const band = rows.filter((r) => r.onPipePt <= 4 && r.alongDeg <= 10 && r.extent >= 12 && r.extent <= 17);
      for (const r of band) console.log(`   right size, NO outline: (${r.c.x.toFixed(1)}, ${r.c.y.toFixed(1)})  extent ${r.extent.toFixed(1)}  ${r.onPipePt.toFixed(1)}pt off  ${r.alongDeg.toFixed(1)}deg off axis`);
    }
    for (const r of all3) {
      console.log(`   (${r.c.x.toFixed(1)}, ${r.c.y.toFixed(1)})  extent ${r.extent.toFixed(1)}  ${r.onPipePt.toFixed(1)}pt off the pipe  ${r.alongDeg.toFixed(1)}deg off its axis`);
    }
  }
}
main();
