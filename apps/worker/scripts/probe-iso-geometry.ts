// What the WIRED pipeline would make of a drawing's spools, without paying for
// the vision half. Free.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-iso-geometry.ts \
//     <file.pdf> <raw.json> <flag-labels.json> [out-raw.json] [--tag-labels t.json]
//
// It runs the exact code path `extractIsoDocument` runs -- locateWeldFlags,
// flagRegions, numberingComplete, readGeometrySpools, buildIsoTags -- with the
// one paid step (reading the number inside each weld flag) REPLAYED from a
// saved file instead of called. `raw.json` supplies the other paid half, the
// sheet reads, which is what the vision pass would return.
//
// That makes the whole integration checkable for nothing, which matters: the
// alternative way to find out whether the wiring works is a ~$9 extraction.
// Writing out-raw.json gives a payload carrying the geometry, ready for
// scripts/rebuild-iso-tags.ts and packages/db/scripts/import-iso-tags.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { flagRegions, locateWeldFlags, numberingComplete, readGeometrySpools } from "../src/extraction/isoGeometrySpools";
import { buildIsoTags, readSpoolTags } from "../src/extraction/iso";

const short = (t: string) => String(t).replace(/^.*-N-/, "N-");

async function main() {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf("--tag-labels");
  const tagLabelsPath = ti >= 0 ? argv[ti + 1] : undefined;
  const [pdfPath, rawPath, labelsPath, outPath] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--tag-labels");
  if (!pdfPath || !rawPath || !labelsPath) {
    console.error("usage: tsx scripts/probe-iso-geometry.ts <file.pdf> <raw.json> <flag-labels.json> [out-raw.json]");
    process.exit(1);
  }
  const pdf = readFileSync(pdfPath);
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  const flagLabels = new Map<string, string>(Object.entries(JSON.parse(readFileSync(labelsPath, "utf8")) as Record<string, string>));
  // export-spool-tags.ts writes its cells as "<page>-<i>"; the pipeline keys
  // spool tags with an "s" so they cannot collide with a weld flag's cell.
  const tagLabels = new Map<string, string>();
  if (tagLabelsPath) {
    for (const [cell, label] of Object.entries(JSON.parse(readFileSync(tagLabelsPath, "utf8")) as Record<string, string>)) {
      tagLabels.set(cell.startsWith("s") ? cell : `s${cell}`, label);
    }
  }

  const sheets: Array<{ pageNumber: number; result: { welds?: Array<{ weld_no: string; weld_type?: string; size?: string }>; spool_tags?: unknown } }> = raw.sheets;
  const pages = sheets.map((s) => s.pageNumber);
  const marksByPage = await locateWeldFlags(pdf, pages);

  const weldNumberOf = (page: number) => (i: number) => {
    const n = Number(String(flagLabels.get(`${page}-${i + 1}`) ?? "").replace(/^[A-Za-z\s]+/, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const geometry = [];
  for (const sheet of sheets) {
    const page = sheet.pageNumber;
    const marks = marksByPage.get(page);
    if (!marks) {
      console.log(`page ${page}: no geometry`);
      continue;
    }
    const regions = flagRegions(page, marks);
    const complete = numberingComplete(
      regions.map((r) => flagLabels.get(r.label)),
      regions.length
    );
    if (!complete) {
      console.log(`page ${page}: ${regions.length} flags, numbering NOT complete -- the vision pass keeps this sheet`);
      continue;
    }
    // Through the SAME unwrapper the worker uses. Tool-call JSON is not
    // validated against the schema, and page 4 of the reference ISO comes
    // back as a JSON STRING rather than the declared string[] -- reading it
    // raw here threw where the worker itself copes.
    const spoolTags = readSpoolTags(sheet.result.spool_tags);
    const g = await readGeometrySpools({
      pdf,
      page,
      marks,
      welds: (sheet.result.welds ?? []).map((w) => ({ weldNo: Number(w.weld_no), weldType: w.weld_type, size: w.size })),
      spoolTags,
      weldNumberOf: weldNumberOf(page),
      tagLabels,
    });
    console.log(
      `page ${page}: ${regions.length} flags numbered 1..${regions.length}; ` +
        (g.trusted ? `cuts after ${g.cuts.join(", ")}` : `REFUSED -- ${g.why}`)
    );
    for (const e of g.evidence) console.log(`   + ${e.why}`);
    for (const c of g.tagChanges) console.log(`   ~ block ${c.block}: ${short(c.from)} -> ${short(c.to)}, per its printed tag's own leader`);
    geometry.push({ ...g, assignment: Object.fromEntries(g.assignment) });
  }

  const tags = buildIsoTags(raw.sheets, geometry as never);
  const spools = tags.filter((t) => t.tagType === "spool");
  const welds = tags.filter((t) => t.tagType === "weld");
  console.log(`\n${spools.length} spool rows, ${spools.filter((s) => /^spool-/.test(s.tagNumber)).length} invented`);
  for (const s of spools) {
    console.log(`  p${s.sourcePage} ${short(s.tagNumber).padEnd(6)} welds [${(s.attributes.weld_numbers as number[]).join(",")}]${s.attributes.from_drawing ? "  [drawing]" : ""}`);
  }
  console.log(`\n${welds.filter((w) => !w.attributes.spool_no).length} of ${welds.length} welds with no spool`);

  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ ...raw, geometry }, null, 2));
    console.log(`\nwrote ${outPath} -- a payload carrying the geometry, ready to rebuild and import`);
  }
}
main();
