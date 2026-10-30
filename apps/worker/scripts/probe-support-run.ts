// Free: walk each chain of printed dimensions on a page and show where the
// supports sit ALONG it -- including the stretches at either end.
//
//   tsx scripts/probe-support-run.ts <dims.json> <supports.json> [page]
//
// The gaps BETWEEN supports are only part of "is the support in the right
// place". A run also has two ends, and the pipe from the last support to the
// end of the run is unsupported just the same.
import { readFileSync } from "node:fs";

const [dimsPath, supportsPath, pageArg] = process.argv.slice(2);
if (!dimsPath || !supportsPath) {
  console.error("usage: tsx scripts/probe-support-run.ts <dims.json> <supports.json> [page]");
  process.exit(1);
}

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const JOIN = 6;
const AT_NODE = 12;

const dims = JSON.parse(readFileSync(dimsPath, "utf8"));
const sup = JSON.parse(readFileSync(supportsPath, "utf8"));

for (const p of dims.pages) {
  const page = p.pageNumber ?? p.page;
  if (pageArg && Number(pageArg) !== page) continue;
  const supports = (sup.pages.find((x: { page: number }) => x.page === page)?.supports ?? []) as Array<{ cell: string; itemNo: string; at: Pt }>;

  type Leg = { cell: string; mm: number | null; from: Pt; to: Pt; degrees: number };
  const legs: Leg[] = [];
  for (const d of p.dimensions) {
    if (!d.attach) continue;
    legs.push({ cell: d.cell, mm: d.mm ?? null, from: d.attach.from, to: d.attach.to, degrees: d.degrees });
  }

  console.log(`\n=== page ${page}: ${legs.length} dimension legs, ${supports.length} supports ===`);
  const used = new Set<string>();
  let chainNo = 0;

  for (const seed of legs) {
    if (used.has(seed.cell)) continue;
    const chain: Leg[] = [seed];
    used.add(seed.cell);
    const near = (a: Pt, b: Pt) => dist(a, b) <= JOIN;
    for (const forward of [true, false]) {
      let end = forward ? seed.to : seed.from;
      for (;;) {
        const next = legs.filter((l) => !used.has(l.cell) && (near(l.from, end) || near(l.to, end)));
        if (next.length !== 1) break;
        const l = next[0];
        used.add(l.cell);
        if (forward) chain.push(l);
        else chain.unshift(l);
        end = near(l.from, end) ? l.to : l.from;
      }
    }

    // Order the chain and collect its nodes.
    let cursor = chain.length > 1 && (near(chain[0].to, chain[1].from) || near(chain[0].to, chain[1].to)) ? chain[0].from : chain[0].to;
    if (chain.length === 1) cursor = chain[0].from;
    const nodes: Pt[] = [cursor];
    const ordered: Leg[] = [];
    for (const leg of chain) {
      const start = near(leg.from, cursor) ? leg.from : leg.to;
      if (!near(start, cursor)) break;
      const finish = start === leg.from ? leg.to : leg.from;
      ordered.push(leg);
      nodes.push(finish);
      cursor = finish;
    }
    if (ordered.length === 0) continue;
    chainNo++;

    const at = new Map<number, string[]>();
    for (const s of supports) {
      let best = Infinity;
      let index = -1;
      nodes.forEach((n, i) => {
        const d = dist(n, s.at);
        if (d < best) {
          best = d;
          index = i;
        }
      });
      if (best <= AT_NODE) at.set(index, [...(at.get(index) ?? []), `${s.cell}(item ${s.itemNo})`]);
    }

    const total = ordered.reduce((n, l) => n + (l.mm ?? 0), 0);
    console.log(`\n  chain ${chainNo}: ${ordered.length} legs, ${total}mm, ${at.size} support point(s)`);
    let running = 0;
    let lastSupportAt: number | null = at.has(0) ? 0 : null;
    if (at.has(0)) console.log(`    node 0  ${at.get(0)!.join(" + ")}`);
    else console.log(`    node 0  -- run end / continues`);
    ordered.forEach((l, i) => {
      running += l.mm ?? 0;
      const here = at.get(i + 1);
      console.log(`      ${String(l.mm ?? "?").padStart(6)}mm  ${l.cell.padEnd(6)} ${String(l.degrees).padStart(4)}deg`);
      if (here) {
        const since = lastSupportAt == null ? running : running - (lastSupportAt as number);
        console.log(`    node ${i + 1}  ${here.join(" + ")}   <- ${since}mm since ${lastSupportAt == null ? "the run end" : "the last support"}`);
        lastSupportAt = running;
      }
    });
    if (lastSupportAt != null && lastSupportAt < total) {
      console.log(`    node ${ordered.length}  -- run end / continues   <- ${total - (lastSupportAt as number)}mm past the last support`);
    } else if (lastSupportAt == null) {
      console.log(`    (no support anywhere on this chain -- ${total}mm unsupported)`);
    }
  }
}
