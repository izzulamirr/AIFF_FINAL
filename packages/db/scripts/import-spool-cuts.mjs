// Stores the spool each weld belongs to according to the DRAWING, alongside the
// spool the vision extraction recorded, so the two can be compared in the UI.
//
//   node scripts/import-spool-cuts.mjs <spool-cuts.json> [--write]
//
// Written as attributes.geometry_spool. Nothing is deleted, no row is created,
// and the stored spool_no is left untouched -- a sheet whose cut count did not
// match its printed spool count is not written at all.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const rel of ["../../../apps/worker/.env", "../../../apps/web/.env.local"]) {
    try {
      const text = readFileSync(resolve(here, rel), "utf8");
      const line = text.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
      if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    } catch {}
  }
  throw new Error("DATABASE_URL not found");
}

const [, , jsonPath, ...rest] = process.argv;
if (!jsonPath) {
  console.error("usage: node scripts/import-spool-cuts.mjs <spool-cuts.json> [--write]");
  process.exit(1);
}
const write = rest.includes("--write");
const data = JSON.parse(readFileSync(jsonPath, "utf8"));
const sql = postgres(loadDatabaseUrl(), { prepare: false });

try {
  let written = 0;
  let differ = 0;
  for (const page of data.pages) {
    if (!page.trusted) {
      console.log(`page ${page.page}: not trusted, skipped`);
      continue;
    }
    for (const a of page.assignment) {
      const [row] = await sql`SELECT attributes FROM extracted_tags WHERE id = ${a.rowId}`;
      if (!row) continue;
      if (a.spool !== a.stored) differ++;
      if (write) {
        await sql`UPDATE extracted_tags SET attributes = ${sql.json({ ...row.attributes, geometry_spool: a.spool })} WHERE id = ${a.rowId}`;
      }
      written++;
    }
    console.log(`page ${page.page}: ${page.assignment.length} welds, cuts after ${page.cuts.join(", ")}`);
  }
  console.log(`\n${written} welds assigned from the drawing, ${differ} of them disagreeing with what was stored`);
  if (!write) console.log("(dry run -- pass --write to store)");
} finally {
  await sql.end();
}
