// Which two WELDS does each dimension span?
//
// A dimension's two tips are reached from the two measured points by witness
// lines that are the SAME offset -- that is what makes the drawn length equal
// the measured length. So the measured segment is the dimension segment slid
// along the witness direction by one unknown distance t. Sweep t and see
// where both ends land on a weld mark: that is the piece of pipe it measures,
// and the spool follows from the welds.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-dimension-welds.ts <dims.json> <weld-geometry.json>
import { readFileSync } from "node:fs";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

const MAX_OFFSET_PT = 260;
const OFFSET_STEP_PT = 0.5;

function main() {
  const [, , dimsPath, weldPath] = process.argv;
  const dims = JSON.parse(readFileSync(dimsPath, "utf8"));
  const geom = JSON.parse(readFileSync(weldPath, "utf8"));

  for (const page of dims.pages) {
    const welds: Array<{ label: string; weldNo: number; mark: Pt }> =
      (geom.pages.find((p: { page: number }) => p.page === page.page)?.welds ?? []).filter((w: { weldNo: number }) => w.weldNo > 0);
    if (welds.length === 0) continue;
    const nearest = (q: Pt) => welds.reduce((best, w) => (dist(w.mark, q) < dist(best.mark, q) ? w : best), welds[0]);

    console.log(`\n=== sheet ${page.page}  (${welds.length} located welds)`);
    for (const d of page.dimensions) {
      if (d.witnessDegrees == null) {
        console.log(`  ${d.cell.padEnd(5)} ${String(d.mm ?? "?").padStart(5)}mm  no witness direction`);
        continue;
      }
      const r = (d.witnessDegrees * Math.PI) / 180;
      let best: { t: number; a: string; b: string; worst: number } | null = null;
      for (const sign of [1, -1]) {
        const u = { x: Math.cos(r) * sign, y: Math.sin(r) * sign };
        for (let t = 0; t <= MAX_OFFSET_PT; t += OFFSET_STEP_PT) {
          const A = { x: d.from.x + u.x * t, y: d.from.y + u.y * t };
          const B = { x: d.to.x + u.x * t, y: d.to.y + u.y * t };
          const wa = nearest(A);
          const wb = nearest(B);
          if (wa.weldNo === wb.weldNo) continue;
          const worst = Math.max(dist(wa.mark, A), dist(wb.mark, B));
          if (!best || worst < best.worst) best = { t, a: wa.label, b: wb.label, worst };
        }
      }
      const tag = best && best.worst <= 6 ? "OK " : best && best.worst <= 15 ? "?  " : "   ";
      console.log(
        `  ${tag}${d.cell.padEnd(5)} ${String(d.mm ?? "?").padStart(5)}mm ${String(d.degrees).padStart(5)}deg  ` +
          (best ? `${best.a} -> ${best.b}  offset ${best.t.toFixed(0)}pt  fit ${best.worst.toFixed(1)}pt` : "nothing")
      );
    }
  }
}
main();
