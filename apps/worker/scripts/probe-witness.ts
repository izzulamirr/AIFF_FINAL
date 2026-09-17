// What do the witness lines at a dimension's tips actually look like?
// Free -- geometry only, no API call.
//   pnpm --filter @easy/worker exec tsx scripts/probe-witness.ts <pdf> <page> <x> <y> [radius]
import { readPageGeometry } from "../src/pdfGeometry";

const MIN_WITNESS_PT = 10;

async function main() {
  const [, , pdf, pageArg, xArg, yArg, rArg] = process.argv;
  const page = Number(pageArg);
  const tip = { x: Number(xArg), y: Number(yArg) };
  const radius = Number(rArg ?? 10);
  const geom = await readPageGeometry(pdf, page);
  const H = geom.height;
  const flip = (p: { x: number; y: number }) => ({ x: p.x, y: p.y }); void H;
  const angleOf = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const d = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    return ((d % 180) + 180) % 180;
  };
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  const segs: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; len: number; lw: number }> = [];
  for (const p of geom.paths) {
    if (p.paint === "fill") continue;
    for (let i = 0; i + 1 < p.points.length; i++) {
      const a = flip(p.points[i]);
      const b = flip(p.points[i + 1]);
      const len = dist(a, b);
      if (len > 0.01) segs.push({ a, b, len, lw: p.lineWidth });
    }
  }
  console.log(`page ${page}  tip ${tip.x},${tip.y}  segments ${segs.length}\n`);
  const hits = [];
  for (const s of segs) {
    if (s.len < MIN_WITNESS_PT) continue;
    const t = Math.max(0, Math.min(1, ((tip.x - s.a.x) * (s.b.x - s.a.x) + (tip.y - s.a.y) * (s.b.y - s.a.y)) / (s.len * s.len)));
    const near = dist(tip, { x: s.a.x + t * (s.b.x - s.a.x), y: s.a.y + t * (s.b.y - s.a.y) });
    if (near > radius) continue;
    // Which end is FAR from the tip? That is the end sitting on the pipe.
    const far = dist(s.a, tip) > dist(s.b, tip) ? s.a : s.b;
    hits.push({ s, near, far });
  }
  hits.sort((x, y) => x.near - y.near);
  for (const h of hits) {
    console.log(
      `len ${h.s.len.toFixed(1).padStart(6)}  lw ${h.s.lw.toFixed(2)}  deg ${angleOf(h.s.a, h.s.b).toFixed(1).padStart(5)}  near ${h.near.toFixed(1).padStart(4)}  ` +
        `(${h.s.a.x.toFixed(1)},${h.s.a.y.toFixed(1)})-(${h.s.b.x.toFixed(1)},${h.s.b.y.toFixed(1)})  far=(${h.far.x.toFixed(1)},${h.far.y.toFixed(1)})`
    );
  }
}
main();
