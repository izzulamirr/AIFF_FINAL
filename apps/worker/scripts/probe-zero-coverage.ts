// A length with NO pipe under it: is it spanning a BOLTED joint, or a WELDED
// fitting? Free.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-zero-coverage.ts <pdf> <dims.json>
//
// The coverage test rejects a length that brackets no pipe, on the grounds
// that a valve is bolted in between two flanges and ships on its own. But a
// reducing tee, a reducer and an elbow interrupt the drawn line too, and those
// are WELDED -- they are part of the spool. Coverage cannot tell them apart;
// the flange bars can, which is the same test the spool cut finder uses.
import { readFileSync } from "node:fs";
import { readPageCount, readPageGeometry } from "../src/pdfGeometry";
import { boltedJoints, findFlanges } from "../src/extraction/isoSpoolCuts";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from a point to a segment. */
function toSeg(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  if (l2 < 1e-9) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
  return dist(p, { x: a.x + t * vx, y: a.y + t * vy });
}

async function main() {
  const [, , pdf, dimsPath] = process.argv;
  if (!pdf || !dimsPath) {
    console.error("usage: tsx scripts/probe-zero-coverage.ts <pdf> <dims.json>");
    process.exit(1);
  }
  const buf = readFileSync(pdf);
  const dims = JSON.parse(readFileSync(dimsPath, "utf8"));
  for (let page = 1; page <= (await readPageCount(pdf)); page++) {
    const { paths } = await readPageGeometry(buf, page);
    const joints = boltedJoints(findFlanges(paths));
    const rows = (dims.pages.find((p: { page: number }) => p.page === page)?.dimensions ?? []).filter(
      (d: { mm: number | null; attach: { coverage: number } | null }) => d.mm != null && d.attach && d.attach.coverage < 0.2
    );
    if (rows.length === 0) continue;
    console.log(`page ${page}: ${joints.length} bolted joints on the sheet`);
    for (const d of rows) {
      const near = joints.map((j) => toSeg(j, d.attach.from, d.attach.to)).sort((a, b) => a - b)[0] ?? Infinity;
      const verdict = near <= 20 ? "BOLTED joint in the span -- ships separately" : "no bolted joint -- a WELDED fitting, part of the spool";
      console.log(`   ${String(d.cell).padEnd(6)} ${String(d.mm).padEnd(6)} cov ${(d.attach.coverage * 100).toFixed(0).padStart(3)}%  nearest joint ${near === Infinity ? "none" : near.toFixed(0) + "pt"}   ${verdict}`);
    }
  }
}
main();
