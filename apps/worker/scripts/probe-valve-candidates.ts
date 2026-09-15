// Dumps every valve-shaped path on a page and says what happened to it, so a
// missing spool cut can be traced to the step that dropped it. No API call.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-valve-candidates.ts <file.pdf> <page> <weld-list.json> <geometry.json>

import { readFileSync } from "node:fs";
import { readPageGeometry, type GeomPath } from "../src/pdfGeometry";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";

type Pt = { x: number; y: number };
const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const boxW = (p: GeomPath) => p.bbox.x1 - p.bbox.x0;
const boxH = (p: GeomPath) => p.bbox.y1 - p.bbox.y0;

function selfCrossing(p: GeomPath): boolean {
  if (p.points.length !== 4) return false;
  const [a, b, c, d] = p.points;
  const side = (o: Pt, q: Pt, r: Pt) => Math.sign((q.x - o.x) * (r.y - o.y) - (q.y - o.y) * (r.x - o.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

async function main() {
  const [, , pdfPath, pageArg, listPath, geoPath] = process.argv;
  const page = Number(pageArg);
  const buf = readFileSync(pdfPath);
  const geom = await readPageGeometry(buf, page);
  const marks = await readWeldMarks(buf, page);
  const geo = JSON.parse(readFileSync(geoPath, "utf8")).pages.find((p: any) => p.page === page);
  const list = JSON.parse(readFileSync(listPath, "utf8")).pages.find((p: any) => p.page === page);

  const numberOf = (i: number) => {
    const n = geo?.welds?.[i]?.weldNo;
    return typeof n === "number" && n > 0 ? n : null;
  };
  const positions = marks.hits.map((h) => h.mark);
  console.log(`page ${page}: ${positions.length} located welds\n`);
  positions.forEach((m, i) => console.log(`  weld ${String(numberOf(i) ?? "?").padStart(2)}  at (${m.x.toFixed(0)},${m.y.toFixed(0)})`));

  // Where a cut is expected but was not found, this is the midpoint to look at.
  const byNo = new Map<number, Pt>();
  positions.forEach((m, i) => { const n = numberOf(i); if (n) byNo.set(n, m); });

  console.log(`\n--- valve-shaped paths ---`);
  const seen: Array<{ kind: string; at: Pt; axis: Pt; extent: number; pts: number }> = [];
  for (const p of geom.paths) {
    if (p.paint !== "stroke" || p.extent < 10 || p.extent > 60) continue;
    if (selfCrossing(p)) seen.push({ kind: "self-crossing quad", at: centre(p), axis: { x: p.points[1].x - p.points[0].x, y: p.points[1].y - p.points[0].y }, extent: p.extent, pts: p.points.length });
  }
  const tri = geom.paths.filter((p) => p.paint === "stroke" && p.points.length === 3 && p.extent >= 10 && p.extent < 40);
  console.log(`${tri.length} candidate triangles, ${seen.length} self-crossing quads`);
  const paired = new Set<number>();
  for (let i = 0; i < tri.length; i++) {
    if (paired.has(i)) continue;
    for (let j = i + 1; j < tri.length; j++) {
      if (paired.has(j)) continue;
      const a = tri[i], b = tri[j];
      if (Math.abs(boxW(a) - boxW(b)) > 1 || Math.abs(boxH(a) - boxH(b)) > 1) continue;
      if (dist(centre(a), centre(b)) > a.extent * 0.9) continue;
      paired.add(i); paired.add(j);
      seen.push({ kind: "triangle pair", at: { x: (centre(a).x + centre(b).x) / 2, y: (centre(a).y + centre(b).y) / 2 }, axis: { x: centre(b).x - centre(a).x, y: centre(b).y - centre(a).y }, extent: a.extent, pts: 3 });
      break;
    }
  }

  const onPipe = seen.filter((s) => positions.length && Math.min(...positions.map((m) => dist(m, s.at))) <= 60);
  console.log(`${seen.length} valve-shaped, ${onPipe.length} of them within 60pt of a weld\n`);
  for (const s of onPipe) {
    const len = Math.hypot(s.axis.x, s.axis.y) || 1;
    const along = (m: Pt) => ((m.x - s.at.x) * s.axis.x + (m.y - s.at.y) * s.axis.y) / len;
    const near = positions
      .map((m, k) => ({ n: numberOf(k), d: dist(m, s.at), side: along(m) }))
      .filter((x) => x.d < 90)
      .sort((a, b) => a.d - b.d);
    console.log(`  ${s.kind.padEnd(20)} at (${s.at.x.toFixed(0)},${s.at.y.toFixed(0)}) extent ${s.extent.toFixed(1)} axis (${s.axis.x.toFixed(0)},${s.axis.y.toFixed(0)})`);
    for (const x of near) console.log(`       weld ${String(x.n).padStart(2)}  ${x.d.toFixed(0)}pt  side ${x.side > 0 ? "+" : "-"}${Math.abs(x.side).toFixed(0)}`);
    const fwd = near.filter((x) => x.side > 0)[0];
    const back = near.filter((x) => x.side < 0)[0];
    console.log(`       -> ${fwd && back ? `pair ${back.n}/${fwd.n}, cut after ${Math.max(Number(fwd.n), Number(back.n)) - 1}` : "NO WELD ON ONE SIDE -- dropped silently"}`);
  }

  // Unlocated triangles near an expected gap are the interesting ones.
  console.log(`\n--- valve-shaped paths NOT near any weld (first 10) ---`);
  for (const s of seen.filter((x) => !onPipe.includes(x)).slice(0, 10)) {
    const d = positions.length ? Math.min(...positions.map((m) => dist(m, s.at))) : Infinity;
    console.log(`  ${s.kind.padEnd(20)} at (${s.at.x.toFixed(0)},${s.at.y.toFixed(0)}) extent ${s.extent.toFixed(1)}  nearest weld ${d.toFixed(0)}pt`);
  }
  console.log(`\nspool tags: ${list.spoolTags.length}`);
}
main();
