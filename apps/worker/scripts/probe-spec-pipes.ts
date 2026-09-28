// Free. Reads a client spec page's tables by geometry and prints what it finds.
//   pnpm --filter @easy/worker exec tsx scripts/probe-spec-pipes.ts <pdf> <page>
import { readFileSync } from "node:fs";
import { readSpecPageTable } from "../src/extraction/specTablePdf";
import { classRowsFromTable } from "../src/extraction/specTable";

async function main() {
  const [, , pdfPath, pageArg] = process.argv;
  const table = await readSpecPageTable(readFileSync(pdfPath), Number(pageArg ?? 1));
  if (!table) return console.log("no size table on this page");
  const rows = classRowsFromTable(table);
  if (!rows) return console.log("a size table, but no Schedule row: not a pipe table");
  console.log("columns:", table.columns.map((c) => c.label).join(" | "));
  console.log("\nPIPES (per size column)");
  rows.pipes.forEach((r) => console.log("  ", `${r.size_min}${r.size_max !== r.size_min ? "-" + r.size_max : ""}`.padEnd(7), String(r.schedule).padEnd(8), String(r.end_type).padEnd(3), r.material));
  console.log(`\nFITTINGS (${rows.fittings.length})`);
  rows.fittings.forEach((r) => console.log("  ", String(r.fitting_type).padEnd(34), `${r.size_min}-${r.size_max}`.padEnd(8), String(r.end_type ?? "-").padEnd(3), String(r.description).slice(0, 44)));
  console.log(`\nFLANGES (${rows.flanges.length})`);
  rows.flanges.forEach((r) => console.log("  ", String(r.flange_type).padEnd(28), `${r.size_min}-${r.size_max}`.padEnd(8), String(r.class ?? "-").padEnd(5), String(r.end_type ?? "-").padEnd(3), String(r.description).slice(0, 40)));
  console.log("\nissues:", rows.issues.length ? rows.issues : "none");
}
main();
