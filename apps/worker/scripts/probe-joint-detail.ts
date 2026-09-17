// Every bolted joint the cut finder ACCEPTS on one page, with where it sits and
// which welds it falls between -- so a suspect cut can be rendered and read.
// Free.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-joint-detail.ts <pdf> <page> <geometry.json>
//
// probe-joints.ts counts joints per page; this one names them, which is what is
// needed when a sheet finds one cut too many and the question is WHICH.
import { readFileSync } from "node:fs";
import { readPageGeometry, type GeomPath } from "../src/pdfGeometry";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";
import { boltedJoints, flankingWelds, type Bar } from "../src/extraction/isoSpoolCuts";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const centre = (p: GeomPath): Pt => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: (p.bbox.y0 + p.bbox.y1) / 2 });

function edgesOf(p: GeomPath) {
  let long = 0;
  let short = Infinity;
  let dir: Pt = { x: 1, y: 0 };
  for (let i = 1; i < p.points.length; i++) {
    const a = p.points[i - 1];
    const b = p.points[i];
    const d = dist(a, b);
    if (d < 0.01) continue;
    if (d > long) { long = d; dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; }
    if (d < short) short = d;
  }
  return { long, short: Number.isFinite(short) ? short : 0, dir };
}

async function main() {
  const [, , pdf, pageArg, geoPath] = process.argv;
  if (!pdf || !pageArg || !geoPath) {
    console.error("usage: tsx scripts/probe-joint-detail.ts <pdf> <page> <geometry.json>");
    process.exit(1);
  }
  const page = Number(pageArg);
  const buf = readFileSync(pdf);
  const geo = JSON.parse(readFileSync(geoPath, "utf8"));
  const geoPage = geo.pages.find((g: { page: number }) => g.page === page);
  const marks = await readWeldMarks(buf, page);
  const positions = marks.hits.map((h) => h.mark);
  const numberOf = (i: number) => {
    const n = geoPage?.welds?.[i]?.weldNo;
    return typeof n === "number" && n > 0 ? n : null;
  };

  const g = await readPageGeometry(buf, page);
  const bars: Bar[] = [];
  for (const p of g.paths) {
    if (p.paint !== "stroke") continue;
    if (p.points.length < 4 || p.points.length > 6) continue;
    const e = edgesOf(p);
    if (e.long < 6 || e.long > 60) continue;
    if (e.short < 0.01 || e.long / e.short < 2.5) continue;
    bars.push({ at: centre(p), dir: e.dir, long: e.long });
  }
  // The cut finder takes candidates from THREE sources, and they are worth
  // telling apart: a spurious cut blamed on a "bolted joint" may have come
  // from the valve-symbol fallback instead.
  const boxW = (p: GeomPath) => p.bbox.x1 - p.bbox.x0;
  const boxH = (p: GeomPath) => p.bbox.y1 - p.bbox.y0;
  const selfCrossing = (p: GeomPath) => {
    if (p.points.length !== 4) return false;
    const [a, b, c, d] = p.points;
    const side = (o: Pt, q: Pt, r: Pt) => Math.sign((q.x - o.x) * (r.y - o.y) - (q.y - o.y) * (r.x - o.x));
    return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
  };
  const joints = boltedJoints(bars);
  const candidates: Array<{ at: Pt; from: string }> = joints.map((at) => ({ at, from: "flange pair" }));
  for (const p of g.paths) {
    if (p.paint !== "stroke" || p.extent < 10 || p.extent > 60) continue;
    if (selfCrossing(p)) candidates.push({ at: centre(p), from: "hourglass symbol" });
  }
  const tri = g.paths.filter((p) => p.paint === "stroke" && p.points.length === 3 && p.extent >= 10 && p.extent < 40);
  const paired = new Set<number>();
  for (let i = 0; i < tri.length; i++) {
    if (paired.has(i)) continue;
    for (let j = i + 1; j < tri.length; j++) {
      if (paired.has(j)) continue;
      const a = tri[i];
      const b = tri[j];
      if (Math.abs(boxW(a) - boxW(b)) > 1 || Math.abs(boxH(a) - boxH(b)) > 1) continue;
      if (dist(centre(a), centre(b)) > a.extent * 0.9) continue;
      paired.add(i);
      paired.add(j);
      candidates.push({ at: { x: (centre(a).x + centre(b).x) / 2, y: (centre(a).y + centre(b).y) / 2 }, from: "triangle pair" });
      break;
    }
  }
  console.log(`page ${page}: ${bars.length} flange bars, ${joints.length} joints, ${candidates.length} candidates, ${positions.length} located welds`);
  for (const { at, from } of candidates) {
    const near = Math.min(...positions.map((m) => dist(m, at)));
    if (near > 60) continue; // not on the pipe -- a glyph in the title block
    const pair = flankingWelds(at, positions);
    const ns = pair ? (pair.map(numberOf) as Array<number | null>) : null;
    const cut = ns && ns[0] && ns[1] ? Math.max(ns[0], ns[1]) - 1 : null;
    console.log(
      `  (${at.x.toFixed(1)}, ${at.y.toFixed(1)})  nearest weld ${near.toFixed(1)}pt  between welds ${ns ? ns.join(" and ") : "(only one side)"}` +
        (cut != null ? `  -> cut after ${cut}` : "") + `   [${from}]`
    );
  }
}
main();
