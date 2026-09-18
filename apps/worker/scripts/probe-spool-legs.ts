// Free: which spools' legs chain into a single run, and what shape is it?
//
//   tsx scripts/probe-spool-legs.ts <envelopes.json> <dims.json>
//
// An envelope is three extents, which describes a solid box; a spool is thin
// pipe tracing the edges of one. Every placed length carries the segment of
// pipe it ATTACHES to, and those segments join end to end, so the run's order
// comes out of the geometry with no weld graph to solve.
//
// Calls `chainLegs` from @easy/shared rather than carrying its own copy of the
// rule -- an earlier version of this probe walked forks instead of refusing
// them and reported N-03's two parallel 385mm branches as one sequential run,
// which is the kind of wrong answer a probe exists to prevent.
import { readFileSync } from "node:fs";
import { chainLegs, shapeExtent, type LegInput } from "@easy/shared";

const [envPath, dimsPath] = process.argv.slice(2);
if (!envPath || !dimsPath) {
  console.error("usage: tsx scripts/probe-spool-legs.ts <envelopes.json> <dims.json>");
  process.exit(1);
}
const { envelopes } = JSON.parse(readFileSync(envPath, "utf8"));
const dims = JSON.parse(readFileSync(dimsPath, "utf8"));
const attachOf = new Map<string, { from: { x: number; y: number }; to: { x: number; y: number } }>();
for (const p of dims.pages) for (const d of p.dimensions) if (d.attach) attachOf.set(d.cell, d.attach);

let chained = 0;
for (const e of envelopes) {
  const legs: LegInput[] = [];
  for (const parts of Object.values(e.parts) as Array<Array<{ cell: string; mm: number; drawnAs: string }>>)
    for (const p of parts) {
      const at = attachOf.get(p.cell);
      if (at) legs.push({ cell: p.cell, mm: p.mm, direction: p.drawnAs as LegInput["direction"], from: at.from, to: at.to });
    }
  const shape = chainLegs(legs);
  if (shape) chained++;
  const name = e.spool.split("-").slice(-2).join("-").padEnd(6);
  if (!shape) {
    console.log(`${name} p${e.page}  ${String(legs.length).padStart(2)} legs  no single run -- keeps the bounding box`);
    continue;
  }
  const x = shapeExtent(shape);
  console.log(
    `${name} p${e.page}  ${String(legs.length).padStart(2)} legs  ${shape.legs.map((l) => `${l.direction} ${l.mm}`).join(" -> ")}` +
      `\n${" ".repeat(14)}extent ${x.upDownMm} up-down x ${x.nsMm} N-S x ${x.ewMm} E-W` +
      (x.upDownMm === e.upDownMm && x.nsMm === e.nsMm && x.ewMm === e.ewMm ? "  (agrees with the envelope)" : "  DIFFERS from the envelope")
  );
}
console.log(`\n${chained} of ${envelopes.length} spools chain into a single run`);
