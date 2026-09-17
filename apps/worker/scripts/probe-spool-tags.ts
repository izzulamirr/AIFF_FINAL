// Which piece of pipe does each printed SPOOL TAG point at?
//
// A sheet's PIPE SPOOLS tags are boxed strings with a leader onto the run,
// and the leader is the drawing SAYING which spool is which. Mapping tags to
// weld blocks in sorted order instead gets sheet 4 wrong: its N-14 leader
// lands on the 6000mm piece between the two FW ticks, not on the top run.
// Free -- geometry only.
//   pnpm --filter @easy/worker exec tsx scripts/probe-spool-tags.ts <pdf> <page> [geometry.json] [cuts.json]
import { readFileSync } from "node:fs";
import { readPageGeometry, type GeomPath } from "../src/pdfGeometry";
import { flankingWelds } from "../src/extraction/isoSpoolCuts";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const HOP_PT = 2.5;
const MAX_HOPS = 12;

async function main() {
  const [, , pdf, pgArg, geomPath, cutsPath] = process.argv;
  const page = Number(pgArg);
  const g = await readPageGeometry(pdf, page);

  const boxes: GeomPath[] = g.paths.filter((p) => {
    if (p.paint !== "stroke") return false;
    const w = p.bbox.x1 - p.bbox.x0, h = p.bbox.y1 - p.bbox.y0;
    return w >= 120 && w <= 420 && h >= 7 && h <= 26 && p.points.length >= 4 && p.points.length <= 6;
  });

  const thin: Array<{ a: Pt; b: Pt; len: number; used?: boolean }> = [];
  for (const p of g.paths) {
    if (p.paint !== "stroke" || p.lineWidth > 1.5) continue;
    for (let i = 1; i < p.points.length; i++) {
      const a = p.points[i - 1], b = p.points[i], len = dist(a, b);
      if (len > 4) thin.push({ a, b, len });
    }
  }
  const pipes: Array<{ a: Pt; b: Pt }> = [];
  for (const p of g.paths) {
    if (p.paint === "fill" || p.lineWidth < 1.5) continue;
    for (let i = 1; i < p.points.length; i++) if (dist(p.points[i - 1], p.points[i]) > 1) pipes.push({ a: p.points[i - 1], b: p.points[i] });
  }

  const nearBox = (p: Pt, b: GeomPath) =>
    Math.max(0, b.bbox.x0 - p.x, p.x - b.bbox.x1) + Math.max(0, b.bbox.y0 - p.y, p.y - b.bbox.y1);

  // Walk the leader: CAD splits a bent one into separate segments.
  function walk(box: GeomPath): { tip: Pt; hops: number } | null {
    let start: Pt | null = null, tip: Pt | null = null;
    for (const s of thin) {
      const da = nearBox(s.a, box), db = nearBox(s.b, box);
      const near = Math.min(da, db);
      if (near > 3) continue;
      const end = da < db ? s.b : s.a;
      if (nearBox(end, box) < 15) continue;
      if (!tip || s.len > dist(start!, tip)) { start = da < db ? s.a : s.b; tip = end; }
    }
    if (!tip) return null;
    const seen = new Set<object>();
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      let next: Pt | null = null;
      for (const s of thin) {
        if (seen.has(s)) continue;
        const da = dist(s.a, tip), db = dist(s.b, tip);
        if (Math.min(da, db) > HOP_PT) continue;
        const other = da < db ? s.b : s.a;
        if (dist(other, tip) < HOP_PT) continue;
        if (nearBox(other, box) < 15) continue;
        seen.add(s);
        next = other;
        break;
      }
      if (!next) return { tip, hops: hop };
      tip = next;
    }
    return { tip, hops: MAX_HOPS };
  }

  const welds = geomPath
    ? (JSON.parse(readFileSync(geomPath, "utf8")).pages.find((p: any) => p.page === page)?.welds ?? [])
        .filter((w: any) => w.mark)
        .map((w: any) => ({ no: w.weldNo, m: w.mark as Pt }))
    : [];
  const spoolOf = new Map<number, string>();
  if (cutsPath) {
    const cu = JSON.parse(readFileSync(cutsPath, "utf8")).pages.find((p: any) => p.page === page);
    for (const a of cu?.assignment ?? []) spoolOf.set(a.weldNo, String(a.spool).replace(/^.*-N-/, "N-"));
  }

  console.log(`page ${page}: ${boxes.length} spool tag boxes\n`);
  for (const b of boxes.sort((x, y) => x.bbox.y0 - y.bbox.y0)) {
    const mid = { x: (b.bbox.x0 + b.bbox.x1) / 2, y: (b.bbox.y0 + b.bbox.y1) / 2 };
    const w = walk(b);
    if (!w) { console.log(`  box@(${mid.x.toFixed(0)},${mid.y.toFixed(0)}): no leader`); continue; }
    // A leader POINTS at the run, it does not have to touch it -- these are
    // broken where the 15109 overall dimension crosses them. Put the tip on
    // the pipe before asking which welds are either side of it, or the two
    // welds bracketing the piece come out on the same side.
    let onPipe = Infinity;
    let at: Pt = w.tip;
    for (const s of pipes) {
      const L = dist(s.a, s.b) || 1;
      const t = Math.max(0, Math.min(1, ((w.tip.x - s.a.x) * (s.b.x - s.a.x) + (w.tip.y - s.a.y) * (s.b.y - s.a.y)) / (L * L)));
      const foot = { x: s.a.x + t * (s.b.x - s.a.x), y: s.a.y + t * (s.b.y - s.a.y) };
      const d = dist(w.tip, foot);
      if (d < onPipe) { onPipe = d; at = foot; }
    }
    const flank = welds.length ? flankingWelds(at, welds.map((x: any) => x.m)) : null;
    const pair = flank ? [welds[flank[0]].no, welds[flank[1]].no].sort((p: number, q: number) => p - q) : null;
    const block = pair ? spoolOf.get(Math.max(pair[0], pair[1])) : undefined;
    console.log(
      `  box@(${mid.x.toFixed(0)},${mid.y.toFixed(0)}) -> tip (${w.tip.x.toFixed(0)},${w.tip.y.toFixed(0)}) ` +
        `hops${w.hops} ${onPipe.toFixed(1)}pt off the run -> on pipe (${at.x.toFixed(0)},${at.y.toFixed(0)})` +
        (pair ? `   between welds ${pair[0]} and ${pair[1]}  -> ${block ?? "?"}` : "   no flanking pair")
    );
  }
}
main();
