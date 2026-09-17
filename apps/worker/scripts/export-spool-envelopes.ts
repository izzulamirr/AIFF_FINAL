// Works out each spool's overall size from the dimensions on the sheets.
// Free -- no API call; the lengths were read once and live in dims.json.
//
//   pnpm --filter @easy/worker exec tsx scripts/export-spool-envelopes.ts \
//       <dims.json> <weld-geometry.json> <spool-cuts.json> <out.json>
//
// Each length is tied to a spool by where it ATTACHES to the pipe, and a
// length that reaches no weld, spans a bolted-in valve, or crosses more than
// one spool is reported as UNPLACED rather than pushed into whichever spool
// is nearest. Every total ships with the dimensions that made it, so the page
// can show the workings and someone who knows the drawing can see which
// length does not belong.
import { readFileSync, writeFileSync } from "node:fs";
import { buildSpoolEnvelopes } from "@easy/shared";

function main() {
  const argv = process.argv.slice(2);
  const fixPath = argv.includes("--corrections") ? argv[argv.indexOf("--corrections") + 1] : undefined;
  const [dimsPath, weldPath, cutsPath, outPath] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--corrections");
  if (!dimsPath || !weldPath || !cutsPath || !outPath) {
    console.error("usage: tsx scripts/export-spool-envelopes.ts <dims.json> <weld-geometry.json> <spool-cuts.json> <out.json>");
    process.exit(1);
  }
  const dims = JSON.parse(readFileSync(dimsPath, "utf8"));
  const geom = JSON.parse(readFileSync(weldPath, "utf8"));
  const cuts = JSON.parse(readFileSync(cutsPath, "utf8"));
  const fixes: Record<string, { mm: number; why: string }> = fixPath ? JSON.parse(readFileSync(fixPath, "utf8")) : {};
  for (const [cell, f] of Object.entries(fixes)) {
    if (!f.why) throw new Error(`correction for ${cell} has no reason; a silent correction is worse than none`);
  }

  const dimensions = dims.pages.flatMap((p: any) =>
    p.dimensions.map((d: any) => ({
      cell: d.cell,
      page: p.page,
      from: d.from,
      to: d.to,
      mm: fixes[d.cell] ? fixes[d.cell].mm : d.mm,
      printedMm: d.mm,
      correctionWhy: fixes[d.cell]?.why ?? null,
      degrees: d.degrees,
      witnessDegrees: d.witnessDegrees,
      attach: d.attach,
    }))
  );
  const welds = geom.pages.flatMap((p: any) =>
    p.welds.filter((w: any) => w.weldNo > 0).map((w: any) => ({ page: p.page, weldNo: w.weldNo, mark: w.mark }))
  );
  const assignment = cuts.pages.flatMap((p: any) =>
    (p.assignment ?? []).map((a: any) => ({ page: p.page, weldNo: a.weldNo, spool: a.spool }))
  );

  const { envelopes, unplaced } = buildSpoolEnvelopes(dimensions, welds, assignment);
  const applied = Object.keys(fixes).filter((c) => dimensions.some((d: { cell: string }) => d.cell === c));
  for (const c of applied) console.log(`corrected ${c}: ${fixes[c].mm}mm -- ${fixes[c].why}`);
  for (const c of Object.keys(fixes)) if (!applied.includes(c)) console.log(`correction for ${c} matched no dimension`);
  if (applied.length) console.log("");
  console.log(`${dimensions.filter((d: any) => d.mm != null).length} lengths over ${welds.length} welds -> ${envelopes.length} envelopes\n`);
  for (const e of envelopes) {
    const workings = Object.entries(e.parts)
      .filter(([, v]) => (v as unknown[]).length > 0)
      .map(([k, v]) => `${k}=${(v as Array<{ mm: number }>).map((x) => x.mm).join("+")}`)
      .join("  ");
    console.log(`  ${e.spool.slice(-4)}  ${String(e.upDownMm).padStart(6)} up  ${String(e.nsMm).padStart(6)} N-S  ${String(e.ewMm).padStart(6)} E-W    ${workings}`);
  }
  if (unplaced.length > 0) {
    // Named, never silently dropped: an unplaced length is either a fitting
    // that does not ship with the pipe or a gap in the reading, and the two
    // look nothing alike once you can see which is which.
    console.log(`\n${unplaced.length} lengths not placed in any spool:`);
    const why = new Map<string, string[]>();
    for (const u of unplaced) why.set(u.why, [...(why.get(u.why) ?? []), `${u.cell}=${u.mm}`]);
    for (const [reason, list] of [...why.entries()].sort()) console.log(`  ${reason.padEnd(22)} ${list.join("  ")}`);
  }
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), derived: true, envelopes, unplaced }, null, 2));
  console.log(`\nwrote ${outPath}`);
}
main();
