// Corrects a weld's TYPE where the extraction misread the WELD LIST table.
//
//   node scripts/fix-weld-types.mjs <corrections.json> [documentId] [--write]
//
// corrections.json: [{ "page": 2, "weldNo": 5, "weldType": "BW", "why": "..." }]
//
// The weld type is the one input the drawing's geometry cannot supply. Number
// and position come from the flags and leaders; the TYPE comes from the WELD
// LIST table, and when that is misread there is currently nothing to catch it.
// A type is not cosmetic either: FW means field weld, a field weld IS the
// forced cut past 6000mm, so it ends a spool on sight -- one weld wrongly
// typed FW invents a boundary and can cost a whole sheet its assignment.
//
// Every correction must carry a `why`, so a value overridden by hand is
// distinguishable from one the extraction produced. The replaced value is kept
// as attributes.weld_type_extracted, written only the first time, and the
// reason as attributes.weld_type_note. No row is created or deleted.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOC_ID = "820944b2-b2b9-467d-a005-22b05e53121d";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const rel of ["../../../apps/worker/.env", "../../../apps/web/.env.local"]) {
    try {
      const text = readFileSync(resolve(here, rel), "utf8");
      const line = text.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
      if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next candidate
    }
  }
  throw new Error("DATABASE_URL not found");
}

const [, , jsonPath, ...rest] = process.argv;
if (!jsonPath) {
  console.error("usage: node scripts/fix-weld-types.mjs <corrections.json> [documentId] [--write]");
  process.exit(1);
}
const write = rest.includes("--write");
const documentId = rest.find((a) => !a.startsWith("--")) ?? DEFAULT_DOC_ID;
const corrections = JSON.parse(readFileSync(jsonPath, "utf8"));
const sql = postgres(loadDatabaseUrl(), { prepare: false });

for (const c of corrections) {
  if (!c.why || String(c.why).trim() === "") {
    console.error(`every correction needs a "why" -- weld ${c.weldNo} on page ${c.page} has none`);
    process.exit(1);
  }
}

try {
  const rows = await sql`
    SELECT id, source_page, attributes FROM extracted_tags
    WHERE document_id = ${documentId} AND tag_type = 'weld'
  `;
  const byKey = new Map(rows.map((r) => [`${r.source_page}:${Number(String(r.attributes?.weld_no ?? "").trim())}`, r]));

  const updates = [];
  for (const c of corrections) {
    const row = byKey.get(`${c.page}:${c.weldNo}`);
    if (!row) {
      console.log(`page ${c.page} weld ${c.weldNo}: no such weld row -- skipped`);
      continue;
    }
    const had = String(row.attributes?.weld_type ?? "");
    if (had === c.weldType) {
      console.log(`page ${c.page} weld ${c.weldNo}: already ${c.weldType}`);
      continue;
    }
    const attrs = { ...row.attributes, weld_type: c.weldType, weld_type_note: c.why };
    if (attrs.weld_type_extracted == null) attrs.weld_type_extracted = had;
    updates.push({ id: row.id, attributes: attrs });
    console.log(`page ${c.page} weld ${c.weldNo}: ${had || "(blank)"} -> ${c.weldType}`);
    console.log(`    ${c.why}`);
  }

  if (!write) {
    console.log(`\n${updates.length} weld type${updates.length === 1 ? "" : "s"} to change (dry run -- pass --write to store)`);
  } else {
    for (const u of updates) {
      await sql`UPDATE extracted_tags SET attributes = ${sql.json(u.attributes)} WHERE id = ${u.id}`;
    }
    console.log(`\ncorrected ${updates.length} weld type${updates.length === 1 ? "" : "s"}; the extracted value is kept as weld_type_extracted`);
  }
} finally {
  await sql.end();
}
