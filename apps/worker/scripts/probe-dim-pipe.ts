// Is there PIPE between the two points a dimension measures?
//
// A spool is what is welded together. A valve is bolted in between two flanges
// and ships on its own, so a dimension spanning one has NO pipe under it --
// which is the physical test for "this length is part of a spool".
//
// A dimension is drawn parallel to what it measures and offset from it, both
// ends by the SAME amount along the witness direction. So slide the whole
// dimension back by one offset t and see what it lands on.
//   pnpm --filter @easy/worker exec tsx scripts/probe-dim-pipe.ts <pdf> <page> <dims.json> <geometry.json> <cuts.json>
import { readFileSync } from "node:fs";
import { readPageGeometry } from "../src/pdfGeometry";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const PIPE_LW = 1.5;
const PARALLEL_DEG = 6;
const MAX_REACH_PT = 200;
const T_GROUP_PT = 4;

async function main() {
  const [, , pdf, pgArg, dimsPath, geomPath, cutsPath] = process.argv;
  const page = Number(pgArg);
  const dims = JSON.parse(readFileSync(dimsPath, "utf8")).pages.find((p: any) => p.page === page);
  const gm = JSON.parse(readFileSync(geomPath, "utf8")).pages.find((p: any) => p.page === page);
  const cu = JSON.parse(readFileSync(cutsPath, "utf8")).pages.find((p: any) => p.page === page);
  const spoolOf = new Map<number, string>((cu?.assignment ?? []).map((a: any) => [a.weldNo, a.spool.replace(/^.*-N-/, "N-")]));
  const named = (gm?.welds ?? []).filter((w: any) => w.mark).map((w: any) => ({ no: w.weldNo, m: w.mark, s: spoolOf.get(w.weldNo) ?? "?" }));

  const geom = await readPageGeometry(pdf, page);
  const pipes: Array<{ a: Pt; b: Pt }> = [];
  for (const p of geom.paths) {
    if (p.paint === "fill" || p.lineWidth < PIPE_LW) continue;
    for (let i = 1; i < p.points.length; i++) if (dist(p.points[i - 1], p.points[i]) > 1) pipes.push({ a: p.points[i - 1], b: p.points[i] });
  }

  const only = process.argv.includes("--cell") ? process.argv[process.argv.indexOf("--cell") + 1] : null;
  for (const d of dims.dimensions) {
    const allOffsets: Array<{ t: number; cov: number }> = [];
    if (d.witnessDegrees == null) { console.log(`${d.cell.padEnd(5)} ${String(d.mm).padEnd(5)} no witness`); continue; }
    const T1 = d.from as Pt, T2 = d.to as Pt;
    const L = dist(T1, T2);
    const dir = { x: (T2.x - T1.x) / L, y: (T2.y - T1.y) / L };
    const wr = (d.witnessDegrees * Math.PI) / 180;
    const u = { x: Math.cos(wr), y: Math.sin(wr) };

    // Offset t that puts the dimension's line onto each pipe segment's line.
    const cands: Array<{ t: number; seg: { a: Pt; b: Pt } }> = [];
    for (const s of pipes) {
      const sl = dist(s.a, s.b);
      const sd = { x: (s.b.x - s.a.x) / sl, y: (s.b.y - s.a.y) / sl };
      const cross = Math.abs(sd.x * dir.y - sd.y * dir.x);
      if (cross > Math.sin((PARALLEL_DEG * Math.PI) / 180)) continue;       // not parallel to the dimension
      const den = u.x * sd.y - u.y * sd.x;
      if (Math.abs(den) < 1e-6) continue;
      const t = ((s.a.x - T1.x) * sd.y - (s.a.y - T1.y) * sd.x) / den;
      if (t < -MAX_REACH_PT || t > MAX_REACH_PT) continue;
      cands.push({ t, seg: s });
    }
    // Group offsets that agree, and measure how much of the span is covered.
    let best: { t: number; cov: number } | null = null;
    for (const c of cands) {
      const group = cands.filter((x) => Math.abs(x.t - c.t) <= T_GROUP_PT);
      const P1 = { x: T1.x + c.t * u.x, y: T1.y + c.t * u.y };
      const spans: Array<[number, number]> = [];
      for (const g of group) {
        const p0 = (g.seg.a.x - P1.x) * dir.x + (g.seg.a.y - P1.y) * dir.y;
        const p1 = (g.seg.b.x - P1.x) * dir.x + (g.seg.b.y - P1.y) * dir.y;
        const lo = Math.max(0, Math.min(p0, p1)), hi = Math.min(L, Math.max(p0, p1));
        if (hi > lo) spans.push([lo, hi]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      let cov = 0, end = 0;
      for (const [lo, hi] of spans) { const s0 = Math.max(lo, end); if (hi > s0) { cov += hi - s0; end = hi; } }
      const frac = cov / L;
      if (!best || frac > best.cov) best = { t: c.t, cov: frac };
      // With --cell, list EVERY candidate offset: which pipe a dimension could
      // be measuring, and how much of it each one puts under the span. That is
      // the only way to see why the attach landed where it did.
      if (only === d.cell) allOffsets.push({ t: c.t, cov: frac });
    }
    if (only === d.cell) {
      const seen = new Set<string>();
      console.log(`
${d.cell}  ${d.mm}mm  candidate offsets (t = how far it slides, cov = pipe under the span):`);
      for (const o of allOffsets.sort((x, y) => Math.abs(x.t) - Math.abs(y.t))) {
        const k = o.t.toFixed(0);
        if (seen.has(k)) continue;
        seen.add(k);
        console.log(`   t ${o.t.toFixed(1).padStart(7)}   cov ${(o.cov * 100).toFixed(0).padStart(3)}%`);
      }
      console.log("");
    }
    const t = best?.t ?? 0;
    const P1 = { x: T1.x + t * u.x, y: T1.y + t * u.y };
    const P2 = { x: T2.x + t * u.x, y: T2.y + t * u.y };
    const nearest = (p: Pt) => (named.length ? named.map((w: any) => ({ ...w, d: dist(w.m, p) })).sort((a: any, b: any) => a.d - b.d)[0] : null);
    const n1 = nearest(P1), n2 = nearest(P2);
    const cov = best?.cov ?? 0;
    const verdict = cov < 0.2 ? "NOT PIPE" : n1 && n2 ? (n1.s === n2.s ? n1.s : `straddles ${n1.s}|${n2.s}`) : "?";
    console.log(
      `${d.cell.padEnd(5)} ${String(d.mm).padEnd(5)} cov${(cov * 100).toFixed(0).padStart(4)}%  t${t.toFixed(0).padStart(5)}  ` +
        `${n1 ? `w${n1.no}(${n1.d.toFixed(0)})` : "-"}/${n2 ? `w${n2.no}(${n2.d.toFixed(0)})` : "-"}  -> ${verdict}`
    );
  }
}
main();
