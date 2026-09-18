// Free probe: the glyph runs near a DIMENSION, and where each sits relative to
// that dimension's own line.
//
//   tsx scripts/probe-glyph-runs.ts <pdf> <page> <x0> <y0> <x1> <y1> [reachPt]
//
// Prints, for each contiguous run of glyph strokes within reach of the span's
// midpoint: how far it sits ALONG the dimension from the midpoint, and how far
// ACROSS the dimension's line. The label finder seeds on the run nearest the
// midpoint, and ACROSS is what tells that run from a "FW" note or a weld flag
// sitting beside the same dimension.
import { readPageGeometry } from "../src/pdfGeometry";

const [pdf, pageS, x0S, y0S, x1S, y1S, reachS] = process.argv.slice(2);
const from = { x: Number(x0S), y: Number(y0S) };
const to = { x: Number(x1S), y: Number(y1S) };
const REACH = Number(reachS ?? 60);
const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
const L = Math.hypot(to.x - from.x, to.y - from.y) || 1;
const dir = { x: (to.x - from.x) / L, y: (to.y - from.y) / L };

const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);
const centre = (p: any) => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });

(async () => {
  const geom = await readPageGeometry(pdf, Number(pageS));
  const glyphs = geom.paths.filter(
    (p: any) => p.paint === "stroke" && p.extent <= 14 && p.points.length >= 3
  );
  const near = glyphs.filter((g: any) => dist(centre(g), mid) <= REACH);
  const runs: any[][] = [];
  const left = near.slice();
  while (left.length) {
    const run = [left.pop()];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = left.length - 1; i >= 0; i--) {
        const g = left[i];
        const hit = run.some((r: any) => {
          const gx = Math.max(0, r.bbox.x0 - g.bbox.x1, g.bbox.x0 - r.bbox.x1);
          const gy = Math.max(0, r.bbox.y0 - g.bbox.y1, g.bbox.y0 - r.bbox.y1);
          return Math.hypot(gx, gy) <= 7;
        });
        if (hit) { run.push(g); left.splice(i, 1); grew = true; }
      }
    }
    runs.push(run as any);
  }
  const rows = runs.map((run) => {
    const b = run.reduce(
      (a: any, g: any) => ({ x0: Math.min(a.x0, g.bbox.x0), y0: Math.min(a.y0, g.bbox.y0), x1: Math.max(a.x1, g.bbox.x1), y1: Math.max(a.y1, g.bbox.y1) }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    );
    const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    const dx = c.x - mid.x, dy = c.y - mid.y;
    // Each GLYPH's own across, since that is what a seed test would see.
    const glyphAcross = run.map((g: any) => {
      const q = centre(g);
      return Math.abs((q.x - mid.x) * -dir.y + (q.y - mid.y) * dir.x);
    });
    return {
      n: run.length, box: b, c, d: dist(c, mid),
      along: Math.abs(dx * dir.x + dy * dir.y),
      across: Math.abs(dx * -dir.y + dy * dir.x),
      minGlyphAcross: Math.min(...glyphAcross),
      maxGlyphAcross: Math.max(...glyphAcross),
    };
  }).sort((a, b) => a.d - b.d);
  for (const r of rows) {
    console.log(
      `d=${r.d.toFixed(1).padStart(5)}  along=${r.along.toFixed(1).padStart(5)}  ACROSS=${r.across.toFixed(1).padStart(5)}` +
      ` (glyphs ${r.minGlyphAcross.toFixed(1)}-${r.maxGlyphAcross.toFixed(1)})  n=${String(r.n).padStart(2)}` +
      `  box=${(r.box.x1 - r.box.x0).toFixed(1)}x${(r.box.y1 - r.box.y0).toFixed(1)}  [${r.box.x0.toFixed(1)},${r.box.y0.toFixed(1)} ${r.box.x1.toFixed(1)},${r.box.y1.toFixed(1)}]`
    );
  }
})();
