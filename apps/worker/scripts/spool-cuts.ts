// Works out which spool each weld belongs to, from the drawing's own geometry.
//
//   pnpm --filter @easy/worker exec tsx scripts/spool-cuts.ts <file.pdf> <weld-list.json> <geometry.json> <out.json>
//
// No API call. The weld list (number, type, bore, stored spool) comes from
// packages/db/scripts/dump-weld-list.mjs; the geometry JSON supplies each
// weld's position and number. A sheet whose cut count does not match its
// printed spool count is left alone rather than guessed at.

import { readFileSync, writeFileSync } from "node:fs";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";
import { readSpoolCuts, assignSpools } from "../src/extraction/isoSpoolCuts";

async function main() {
  const [, , pdfPath, listPath, geoPath, outPath] = process.argv;
  if (!pdfPath || !listPath || !geoPath || !outPath) {
    console.error("usage: tsx scripts/spool-cuts.ts <file.pdf> <weld-list.json> <geometry.json> <out.json>");
    process.exit(1);
  }
  const buf = readFileSync(pdfPath);
  const list = JSON.parse(readFileSync(listPath, "utf8"));
  const geo = JSON.parse(readFileSync(geoPath, "utf8"));

  const out: Array<{ page: number; cuts: number[]; trusted: boolean; assignment: Array<{ rowId: number; weldNo: number; spool: string; stored: string }> }> = [];
  let agree = 0;
  let differ = 0;

  for (const p of list.pages as Array<{ page: number; welds: Array<{ rowId: number; weldNo: number; weldType: string; size: string; storedSpool: string }>; spoolTags: string[] }>) {
    const geoPage = (geo.pages as Array<{ page: number; welds: Array<{ weldNo: number | null }> }>).find((g) => g.page === p.page);
    const marks = await readWeldMarks(buf, p.page);
    // A weld whose flag was never read has no number. Guard against 0 as well
    // as null: an unread label parsed to 0, and a cut computed from it lands at
    // -1 and can accidentally satisfy the count check.
    const numberOf = (i: number) => {
      const n = geoPage?.welds?.[i]?.weldNo;
      return typeof n === "number" && n > 0 ? n : null;
    };
    const { cuts, evidence, rejected } = await readSpoolCuts(buf, p.page, marks, p.welds, numberOf);

    const expected = p.spoolTags.length - 1;
    console.log(`\npage ${p.page}: ${p.spoolTags.length} spool tags -> ${expected} cuts expected; found ${cuts.length}${cuts.length ? ` [${cuts.join(", ")}]` : ""}`);
    for (const e of evidence) console.log(`   + ${e}`);
    for (const r of rejected) console.log(`   - ${r}`);

    const trusted = cuts.length === expected && expected >= 0;
    if (!trusted) {
      console.log(`   !! left alone: ${cuts.length} cuts for ${p.spoolTags.length} spools`);
      out.push({ page: p.page, cuts, trusted: false, assignment: [] });
      continue;
    }
    const assigned = assignSpools(p.welds, cuts, p.spoolTags);
    const assignment = p.welds
      .map((w) => ({ rowId: w.rowId, weldNo: w.weldNo, spool: assigned.get(w.weldNo) ?? "", stored: w.storedSpool }))
      .filter((a) => a.spool);
    const changed = assignment.filter((a) => a.spool !== a.stored);
    agree += assignment.length - changed.length;
    differ += changed.length;
    console.log(`   ${assignment.length - changed.length} welds agree with what is stored, ${changed.length} differ`);
    for (const ch of changed) console.log(`      weld ${ch.weldNo}: stored ${ch.stored.slice(-4)} -> drawing says ${ch.spool.slice(-4)}`);
    out.push({ page: p.page, cuts, trusted: true, assignment });
  }

  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), pages: out }, null, 2));
  console.log(`\ntotal across trusted sheets: ${agree} agree, ${differ} differ`);
  console.log(`wrote ${outPath}`);
}
main();
