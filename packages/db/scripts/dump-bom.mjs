// Dump a document's BILL OF MATERIAL rows, per page, for the free geometry
// scripts to read.
//
//   node scripts/dump-bom.mjs <out.json> [documentId]
//
// The geometry can find every balloon on a drawing but not what any of them
// NAMES -- that is in the BOM, which is a table and was read once already.
// `export-pipe-supports.ts` uses it to turn "balloon 18" into "PRIMARY
// SUPPORT - SC101", which is what makes support detection a lookup rather
// than symbol recognition.
import { readFileSync, writeFileSync } from "node:fs";
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
    } catch {
      // try the next candidate
    }
  }
  throw new Error("DATABASE_URL not found");
}

const [, , outFile, documentId] = process.argv;
if (!outFile) {
  console.error("usage: node scripts/dump-bom.mjs <out.json> [documentId]");
  process.exit(1);
}

const sql = postgres(loadDatabaseUrl(), { prepare: false });
try {
  const docId =
    documentId ??
    (await sql`SELECT id FROM documents WHERE doc_type = 'iso' ORDER BY uploaded_at DESC LIMIT 1`)[0]?.id;
  if (!docId) {
    console.error("No ISO document found.");
    process.exit(1);
  }

  const rows = await sql`
    SELECT source_page, tag_number, attributes
    FROM extracted_tags
    WHERE document_id = ${docId} AND tag_type = 'bom_item'
    ORDER BY source_page, tag_number
  `;

  const bom = rows.map((r) => {
    const a = r.attributes ?? {};
    return {
      page: r.source_page ?? 1,
      // The balloon carries the ITEM NUMBER. Where the extraction stored it
      // under item_no that is what to use; otherwise the row's own tag
      // number is the item number, which is how the older sheets read.
      item_no: String(a.item_no ?? r.tag_number ?? "").trim(),
      component_type: a.component_type ?? null,
      description: a.description ?? null,
      size: a.size ?? null,
      quantity: a.quantity ?? null,
      spec_class: a.spec_class ?? a.item_spec_class ?? null,
    };
  });

  writeFileSync(outFile, JSON.stringify({ documentId: docId, bom }, null, 2));
  const supports = bom.filter((r) => /support/i.test(`${r.component_type ?? ""} ${r.description ?? ""}`));
  console.log(`wrote ${outFile}: ${bom.length} BOM rows, ${supports.length} of them supports`);
  for (const s of supports) console.log(`   page ${s.page}  item ${s.item_no.padEnd(4)} x${String(s.quantity).padEnd(4)} ${s.description}`);
} finally {
  await sql.end();
}
