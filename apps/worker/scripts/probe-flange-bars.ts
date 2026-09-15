// Lists the small closed paths near a set of points, so the shape a FLANGE is
// drawn as can be measured rather than guessed. No API call.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-flange-bars.ts <file.pdf> <page> <x,y> [<x,y>...]

import { readFileSync } from "node:fs";
import { readPageGeometry, type GeomPath } from "../src/pdfGeometry";

type Pt = { x: number; y: number };
const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

async function main() {
  const [, , pdfPath, pageArg, ...pts] = process.argv;
  const geom = await readPageGeometry(readFileSync(pdfPath), Number(pageArg));
  const targets = pts.map((s) => {
    const [x, y] = s.split(",").map(Number);
    return { x, y };
  });
  for (const t of targets) {
    console.log(`\n=== within 45pt of (${t.x},${t.y}) ===`);
    const near = geom.paths
      .filter((p) => p.extent < 70 && dist(centre(p), t) < 45)
      .sort((a, b) => dist(centre(a), t) - dist(centre(b), t));
    for (const p of near) {
      const w = p.bbox.x1 - p.bbox.x0;
      const h = p.bbox.y1 - p.bbox.y0;
      // Longest and shortest edge of the path, which is what tells a thin bar
      // from a blob far better than an axis-aligned bounding box does.
      const edges: number[] = [];
      for (let i = 1; i < p.points.length; i++) edges.push(dist(p.points[i - 1], p.points[i]));
      if (p.closed && p.points.length > 2) edges.push(dist(p.points[p.points.length - 1], p.points[0]));
      const long = edges.length ? Math.max(...edges) : 0;
      const short = edges.length ? Math.min(...edges) : 0;
      console.log(
        `  ${String(p.points.length).padStart(2)}pt ${p.paint.padEnd(11)} ${p.closed ? "closed" : "open  "}` +
          ` bbox ${w.toFixed(1)}x${h.toFixed(1)} extent ${p.extent.toFixed(1)}` +
          ` edges long ${long.toFixed(1)} short ${short.toFixed(1)} ratio ${short > 0.01 ? (long / short).toFixed(1) : "-"}` +
          ` lw ${p.lineWidth.toFixed(2)} at (${centre(p).x.toFixed(0)},${centre(p).y.toFixed(0)}) d=${dist(centre(p), t).toFixed(0)}`
      );
    }
  }
}
main();
