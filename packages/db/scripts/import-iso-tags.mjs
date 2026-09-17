// Replace a document's extracted tags with a fresh ISO extraction.
//
//   pnpm --filter @easy/worker exec tsx scripts/extract-iso.ts <pdf> raw.json      # the paid half
//   pnpm --filter @easy/worker exec tsx scripts/rebuild-iso-tags.ts raw.json tags.json
//   node scripts/import-iso-tags.mjs tags.json [documentId] [--write]
//
// DESTRUCTIVE: it deletes every extracted_tags row for the document and
// inserts the new set, exactly as a worker re-run would. Anything written on
// top of the old rows goes with them -- geometry_spool, spool_no_vision, the
// derived envelopes -- so re-apply those afterwards:
//
//   node scripts/import-weld-geometry.mjs geometry.json
//   node scripts/import-spool-cuts.mjs cuts.json --write
//   node scripts/apply-drawing-spools.mjs cuts.json --write
//   node scripts/import-spool-envelopes.mjs envelopes.json --write
//
// The rows it is about to delete are written to a backup file first, without
// being asked. A destructive step that cannot be undone is worth one file.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOC_ID = "820944b2-b2b9-467d-a005-22b05e53121d";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const rel of ["../../apps/worker/.env", "../../apps/web/.env.local"]) {
    try {
      const text = readFileSync(resolve(here, "..", rel), "utf8");
      const line = text.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
      if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next candidate
    }
  }
  throw new Error("DATABASE_URL not found");
}

// Same normalisation the pipeline applies, kept here so this script does not
// need to import @easy/shared (packages/db does not depend on it).
const normalizeTagNumber = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

const [, , tagsPath, ...rest] = process.argv;
if (!tagsPath) {
  console.error("usage: node scripts/import-iso-tags.mjs <tags.json> [documentId] [--write]");
  process.exit(1);
}
const write = rest.includes("--write");
const documentId = rest.find((a) => !a.startsWith("--")) ?? DEFAULT_DOC_ID;

const { tags } = JSON.parse(readFileSync(tagsPath, "utf8"));
const counts = new Map();
for (const t of tags) counts.set(t.tagType, (counts.get(t.tagType) ?? 0) + 1);
console.log(`${tags.length} tags to import: ${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}\n`);

const sql = postgres(loadDatabaseUrl(), { prepare: false });
try {
  const [doc] = await sql`SELECT id, project_id, doc_type, file_name FROM documents WHERE id = ${documentId}`;
  if (!doc) throw new Error(`no document ${documentId}`);
  const existing = await sql`SELECT * FROM extracted_tags WHERE document_id = ${documentId}`;
  const was = new Map();
  for (const r of existing) was.set(r.tag_type, (was.get(r.tag_type) ?? 0) + 1);
  console.log(`document: ${doc.file_name}`);
  console.log(`replacing ${existing.length} rows: ${[...was.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}`);

  if (!write) {
    console.log(`\ndry run -- pass --write to replace them`);
  } else {
    const backup = `${tagsPath.replace(/\.json$/, "")}-replaced-${Date.now()}.json`;
    writeFileSync(backup, JSON.stringify(existing, null, 2));
    console.log(`\nthe ${existing.length} rows being deleted are saved to ${backup}`);

    await sql.begin(async (tx) => {
      await tx`DELETE FROM extracted_tags WHERE document_id = ${documentId}`;
      for (const t of tags) {
        const num = String(t.tagNumber ?? "").trim();
        if (!num) continue; // a row with no key can never be matched or read
        await tx`
          INSERT INTO extracted_tags (project_id, document_id, doc_type, tag_type, tag_number, tag_number_normalized, source_page, attributes)
          VALUES (${doc.project_id}, ${documentId}, ${doc.doc_type}, ${t.tagType}, ${num},
                  ${normalizeTagNumber(num)}, ${t.sourcePage ?? null}, ${sql.json(t.attributes ?? {})})
        `;
      }
    });
    const after = await sql`SELECT tag_type, count(*)::int AS n FROM extracted_tags WHERE document_id = ${documentId} GROUP BY tag_type ORDER BY tag_type`;
    console.log(`stored: ${after.map((r) => `${r.n} ${r.tag_type}`).join(", ")}`);
    console.log(`\nthe geometry layers were deleted with the old rows -- re-apply them now (see the header of this file)`);
  }
} finally {
  await sql.end();
}
