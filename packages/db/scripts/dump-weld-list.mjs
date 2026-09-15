// Dumps a document's weld list (number, type, bore) and its spool tags per
// sheet, so the worker side can compute spool boundaries from the drawing
// without needing a database connection of its own.
//
//   node scripts/dump-weld-list.mjs <out.json> [documentId]

import { readFileSync, writeFileSync } from "node:fs";
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
    } catch {}
  }
  throw new Error("DATABASE_URL not found");
}

const [, , outPath, docArg] = process.argv;
if (!outPath) {
  console.error("usage: node scripts/dump-weld-list.mjs <out.json> [documentId]");
  process.exit(1);
}
const documentId = docArg ?? DEFAULT_DOC_ID;
const sql = postgres(loadDatabaseUrl(), { prepare: false });
try {
  const rows = await sql`
    SELECT id, source_page, attributes FROM extracted_tags
    WHERE document_id = ${documentId} AND tag_type = 'weld'
    ORDER BY source_page, id
  `;
  const byPage = new Map();
  for (const r of rows) {
    const a = r.attributes ?? {};
    if (a.weld_no == null) continue;
    const p = byPage.get(r.source_page) ?? { page: r.source_page, welds: [] };
    p.welds.push({
      rowId: r.id,
      weldNo: Number(a.weld_no),
      weldType: String(a.weld_type ?? ""),
      size: String(a.size ?? ""),
      storedSpool: String(a.spool_no ?? ""),
    });
    byPage.set(r.source_page, p);
  }
  const pages = [...byPage.values()].sort((a, b) => a.page - b.page).map((p) => ({
    ...p,
    spoolTags: [...new Set(p.welds.map((w) => w.storedSpool).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  }));
  writeFileSync(outPath, JSON.stringify({ documentId, pages }, null, 2));
  console.log(`wrote ${outPath}: ${pages.length} sheets, ${rows.length} welds`);
} finally {
  await sql.end();
}
