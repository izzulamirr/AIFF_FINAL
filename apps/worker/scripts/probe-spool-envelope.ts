// Per-spool extents, derived. No API call.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-spool-envelope.ts <dims.json> <weld-geometry.json> <spool-cuts.json>
import { readFileSync } from "node:fs";
import { plantAxis } from "@easy/shared";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const AXES = [{ name: "UP-DOWN" }, { name: "N-S" }, { name: "E-W" }];
// The plant axis, via the sheet's north arrow -- not "the 30-degree one".
const axisOf = (deg: number) => plantAxis(deg) ?? "other";

function main() {
  const [, , dimsPath, weldPath, cutsPath] = process.argv;
  const dims = JSON.parse(readFileSync(dimsPath, "utf8"));
  const geom = JSON.parse(readFileSync(weldPath, "utf8"));
  const cuts = JSON.parse(readFileSync(cutsPath, "utf8"));

  type Entry = { mm: number; from: Pt; to: Pt; cell: string };
  const perSpool = new Map<string, { page: number; axes: Map<string, Entry[]> }>();

  /**
   * Drop any dimension whose span is CONTAINED in another on the same axis.
   *
   * A drawing gives both the whole and its parts -- sheet 4 carries a 15109
   * overall with a 6000 inside it -- and summing all of them counts the same
   * pipe twice. Containment is decided by projecting both onto the axis, so
   * the outboard offset an overall dimension is drawn at does not matter.
   */
  const outermost = (list: Entry[]): Entry[] => {
    const span = (e: Entry) => {
      const dx = e.to.x - e.from.x;
      const dy = e.to.y - e.from.y;
      const len = Math.hypot(dx, dy) || 1;
      const u = { x: dx / len, y: dy / len };
      const t0 = e.from.x * u.x + e.from.y * u.y;
      const t1 = e.to.x * u.x + e.to.y * u.y;
      return [Math.min(t0, t1), Math.max(t0, t1)] as const;
    };
    return list.filter((a) => {
      const [a0, a1] = span(a);
      return !list.some((b) => {
        if (b === a || b.mm <= a.mm) return false;
        const [b0, b1] = span(b);
        return b0 <= a0 + 2 && a1 <= b1 + 2;
      });
    });
  };

  for (const page of dims.pages) {
    const welds: Array<{ weldNo: number; mark: Pt }> = (geom.pages.find((p: { page: number }) => p.page === page.page)?.welds ?? []).filter(
      (w: { weldNo: number }) => w.weldNo > 0
    );
    const assign: Array<{ weldNo: number; spool: string }> = cuts.pages.find((p: { page: number }) => p.page === page.page)?.assignment ?? [];
    const spoolOf = new Map(assign.map((a) => [a.weldNo, a.spool]));
    if (welds.length === 0 || spoolOf.size === 0) continue;

    console.log(`\n=== sheet ${page.page}`);
    for (const d of page.dimensions) {
      if (d.mm == null || d.witnessDegrees == null) continue;
      const r = (d.witnessDegrees * Math.PI) / 180;
      const mid = { x: (d.from.x + d.to.x) / 2, y: (d.from.y + d.to.y) / 2 };
      // Slide the dimension along its witness direction until it sits on the
      // pipe: the offset where its midpoint comes nearest a weld.
      let best: { t: number; weldNo: number; gap: number } | null = null;
      for (const sign of [1, -1]) {
        const u = { x: Math.cos(r) * sign, y: Math.sin(r) * sign };
        for (let t = 0; t <= 260; t += 0.5) {
          const q = { x: mid.x + u.x * t, y: mid.y + u.y * t };
          for (const w of welds) {
            const gap = dist(w.mark, q);
            if (!best || gap < best.gap) best = { t, weldNo: w.weldNo, gap };
          }
        }
      }
      if (!best) continue;
      const spool = spoolOf.get(best.weldNo);
      const axis = axisOf(d.degrees);
      console.log(
        `  ${d.cell.padEnd(5)} ${String(d.mm).padStart(5)}mm ${axis.padEnd(9)} -> weld ${String(best.weldNo).padStart(2)} (${best.gap.toFixed(1)}pt at offset ${best.t.toFixed(0)})  ${spool ? spool.slice(-4) : "?"}`
      );
      if (!spool) continue;
      const e = perSpool.get(spool) ?? { page: page.page, axes: new Map() };
      const list = e.axes.get(axis) ?? [];
      list.push({ mm: d.mm, from: d.from, to: d.to, cell: d.cell });
      e.axes.set(axis, list);
      perSpool.set(spool, e);
    }
  }

  console.log(`\n=== per-spool extents (sum per axis -- an UPPER BOUND on the true extent)`);
  for (const [spool, e] of [...perSpool.entries()].sort()) {
    const kept = (n: string) => outermost(e.axes.get(n) ?? []);
    const get = (n: string) => kept(n).reduce((a, b) => a + b.mm, 0);
    const parts = AXES.map((a) => `${a.name} ${String(get(a.name)).padStart(6)}`).join("  ");
    const detail = AXES.map((a) => `${a.name}=[${kept(a.name).map((x) => x.mm).join("+")}]`).join(" ");
    console.log(`  ${spool.slice(-4)}  ${parts}    ${detail}`);
  }
}
main();
